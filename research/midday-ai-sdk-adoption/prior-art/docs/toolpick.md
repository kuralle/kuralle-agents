# toolpick — firsthand inspection

Repo: `research/midday-ai-sdk-adoption/prior-art/clones/toolpick`
Source: `github.com/pontusab/toolpick` (Pontus Abrahamsson — Midday founder)
Inspected: 2026-06-09. Single commit `3c49fe2` (2026-03-31 "feat: add relatedTools for workflow dependency expansion"), shallow/squashed clone.

## License (verified)

- **MIT**, declared in `package.json:7` (`"license": "MIT"`).
- **No `LICENSE` file** in the repo root (`cat LICENSE` → not found; only `.gitignore`, `bun.lock`, `package.json`, `README.md`, `src`, `tsconfig.json`, `tsup.config.ts`). License is asserted in package metadata only — no full license text shipped.

## What it is

`toolpick` does **dynamic tool selection for the Vercel AI SDK** — it picks a relevant subset of tools per step so the model only sees the handful that matter, instead of all N tools. Output is a list of tool names destined for the AI SDK `activeTools` field. Version `0.4.0`.

## AI-SDK-native? Yes — deeply.

`ai` is a **required (non-optional) peer dependency** (`package.json`: `peerDependencies.ai: ">=4.0"`, `peerDependenciesMeta.ai.optional: false`). 16 source-line imports from `"ai"`. It consumes both runtime helpers and types:

- Runtime: `embed`, `embedMany`, `cosineSimilarity` (semantic.ts), `generateText`, `Output` (reranker.ts), `tool`, `zodSchema` (search-tool.ts).
- Types: `PrepareStepFunction`, `LanguageModelMiddleware`, `ToolSet`, `EmbeddingModel`, `LanguageModel`, `StepResult`, `ModelMessage`.

It is not a generic library wrapped for AI SDK — it is built around AI SDK's `prepareStep`/`activeTools`/middleware extension points. `zod` is also a required peer (`>=3.25 || >=4.0`).

## API surface (real signatures)

From `src/index.ts` (public exports) and `src/tool-index.ts`:

```ts
// factory
function createToolIndex<TOOLS extends ToolSet>(
  tools: TOOLS,
  options?: ToolIndexOptions,
): ToolIndex<TOOLS>;

interface ToolIndex<TOOLS extends ToolSet = ToolSet> {
  warmUp(): Promise<void>;                                   // eager embed + optional enrich
  select(query: string, options?: SelectOptions): Promise<string[]>;  // names for activeTools
  prepareStep(options?: SelectOptions): PrepareStepFunction<TOOLS>;    // primary AI SDK hook
  middleware(options?: SelectOptions): LanguageModelMiddleware;        // wrapLanguageModel path
  searchTool(): /* AI SDK tool() */ ...;                    // meta-tool "search_tools"
  readonly toolNames: (keyof TOOLS & string)[];
}

interface ToolIndexOptions {
  strategy?: "hybrid" | "semantic" | "combined";   // default: embeddingModel ? "combined" : "hybrid"
  embeddingModel?: EmbeddingModel;                 // from ai
  embeddingCache?: EmbeddingCacheOptions;          // { load(): Promise<number[][]|null>; save(emb): Promise<void> }
  rerankerModel?: LanguageModel;                   // optional LLM rerank tier
  enrichDescriptions?: boolean;                    // LLM-expand descriptions w/ synonyms at warmUp
  relatedTools?: Record<string, string[]>;         // workflow dependency expansion
}

interface SelectOptions {
  maxTools?: number;        // default 5
  alwaysActive?: string[];  // always-included names
  threshold?: number;       // min score filter
  adaptive?: boolean;       // default true — elbow cutoff (return < maxTools on score gap)
  relatedTools?: Record<string, string[]>;  // per-call override
}

// also exported: extractQuery, fileCache, and the types above
```

`fileCache(path)` (src/cache.ts) is a JSON file `EmbeddingCacheOptions` so embeddings survive restarts. A second entrypoint `./eval` (`src/eval/index.ts`) provides a top1/top3/top5 accuracy harness.

## Core mechanism

### Indexing
`createToolIndex` builds a `ToolDescription[]` from each tool's `description` plus its **input parameter names** (`buildToolDescription` + `extractParamNames`, which digs `inputSchema.properties` / `.jsonSchema.properties` / zod `.shape`). Strategy defaults to `"combined"` when an `embeddingModel` is given, else `"hybrid"` (free, zero API calls). `tool-index.ts:158-159`.

### Three search engines (ranking substrate)
- **HybridSearch** (`search/hybrid.ts`) — hand-rolled **BM25** (k1=1.2, b=0.75) + **TF-IDF cosine**, fused 20%/80% (`HYBRID_ALPHA=0.2`). The tool **name is repeated 3×** into the indexed text (`NAME_BOOST_REPEAT=3`) so name matches dominate. No network.
- **SemanticSearch** (`search/semantic.ts`) — `embedMany` over `"${name}: ${text}"` at init, `embed` the query at search time, rank by `cosineSimilarity`. Embeddings are cached via `init()` memoization + optional `embeddingCache`.
- **CombinedSearch** (`search/combined.ts`) — runs hybrid + semantic in `Promise.all`, fuses 30%/70% (hybrid/semantic). **Fails soft**: any error → falls back to pure hybrid (`catch { return this.hybrid.search(...) }`).

`fuseResults` (`search/fusion.ts`) normalizes each result set to [0,1] by its own top score, then weighted-sums.

### select() ranking tiers (tool-index.ts:216-245)
1. `fetchCount = rerankerModel ? maxTools*3 : maxTools` — over-fetch when a reranker will prune.
2. `engine.search(query, fetchCount)`.
3. **threshold** filter (if set).
4. **LLM rerank** tier (if `rerankerModel`): `rerank()` asks a cheap LLM to pick the best `maxTools`, ranked. When ≤50 tools (`RERANK_TOOL_LIMIT`) the LLM sees **all** tools, not just candidates — adding reasoning embeddings can't ("informal, slang, or abbreviated"). Fails soft to `candidates.slice(0, maxTools)`.
5. **adaptive elbow** (`findElbow`, default on): cut at the largest relative score drop (`GAP_RATIO=0.4`, `MIN_ADAPTIVE=2`) → returns *fewer* than maxTools when there's a clear gap.
6. merge `alwaysActive`, then **`expandRelated`** (workflow deps), filter to real tool names.

### prepareStep() — per-step selection with fallback paging (integrations/prepare-step.ts)
The primary AI SDK integration returns `{ activeTools }`. Per step:
- `extractQuery(messages, steps, stepNumber)` derives the query (anchor = longest user message so intent keywords survive a terminal "Yes"/"Ok"; step-N uses last assistant text, or conversation + completed tool names).
- counts **`consecutiveFailures`** = trailing steps with zero tool calls.
- **≥2 failures → expose ALL tools** (`...toolNames`).
- otherwise **page** the ranked list: `page = consecutiveFailures`, fetch `maxTools*(page+1)`, take the slice at `offset = page*maxTools` — i.e. on a miss it advances to the *next page* of candidates instead of re-showing the same set.
- merge alwaysActive + `expandRelated`, filter to valid names.

Note `prepareStep` and `middleware` re-implement their own selection loop (paging / `transformParams`) rather than calling `select()`; the rerank+threshold+elbow tiers above are `select()`-only.

### search_tools meta-tool (integrations/search-tool.ts)
`searchTool()` returns an AI SDK `tool()` (zod input `{ query }`) the model can call mid-run to **discover tools outside the current activeTools window**, returning `{name, description, relevance}` + a hint. This is the escape hatch when selection misses.

### relatedTools (the single commit's feature)
`expandRelated(names, map)` pulls in dependency tools whenever a key tool is selected — e.g. selecting `create_invoice` also activates `get_customer`. Applied in select, prepareStep, and middleware.

## Verbatim source snippets

`src/tool-index.ts:216-245` — the select() ranking pipeline:
```ts
async select(query: string, selectOptions: SelectOptions = {}): Promise<string[]> {
  const { maxTools = 5, alwaysActive = [], threshold, adaptive = true } = selectOptions;
  ...
  const fetchCount = rerankerModel ? maxTools * 3 : maxTools;
  let results = await engine.search(query, fetchCount);
  if (threshold !== undefined) {
    results = results.filter((r) => r.score >= threshold);
  }
  if (rerankerModel) {
    results = await rerank(rerankerModel, query, results, descriptionMap, maxTools);
  }
  if (adaptive) {
    results = findElbow(results, maxTools);
  }
  const selected = results.map((r) => r.name);
  const merged = [...new Set([...selected, ...alwaysActive])];
  const expanded = expandRelated(merged, relatedMap);
  return expanded.filter((name) => toolNameSet.has(name));
}
```

`src/integrations/prepare-step.ts:48-65` — fallback paging / full-expose on repeated misses:
```ts
if (consecutiveFailures >= 2) {
  const activeTools = [...new Set([...toolNames, ...alwaysActive])];
  return { activeTools: asActiveTools<TOOLS>(activeTools) };
}
const page = consecutiveFailures;
const windowSize = maxTools * (page + 1);
const results = await engine.search(query, windowSize);
const offset = page * maxTools;
const pageResults = results.slice(offset, offset + maxTools);
const selected = pageResults.map((r) => r.name);
const merged = [...new Set([...selected, ...alwaysActive])];
const expanded = expandRelated(merged, relatedMap);
const activeTools = expanded.filter((name) => toolNameSet.has(name));
return { activeTools: asActiveTools<TOOLS>(activeTools) };
```

`src/search/semantic.ts:39-50` — embedding cache + embedMany at init:
```ts
const values = this.tools.map((t) => `${t.name}: ${t.text}`);
const { embeddings } = await embedMany({ model: this.model, values });
this.embeddings = embeddings;
if (this.cache) {
  await this.cache.save(embeddings);
}
```

`src/reranker.ts:20-27` — LLM rerank sees the full set when ≤50 tools:
```ts
if (candidates.length <= maxResults) return candidates;
const allNames = Array.from(descriptions.keys());
const useFullSet = allNames.length <= RERANK_TOOL_LIMIT;   // 50
const toolList = useFullSet
  ? allNames.map((n) => `- ${n}: ${descriptions.get(n) ?? ""}`).join("\n")
  : candidates.map((c) => `- ${c.name}: ${descriptions.get(c.name) ?? ""}`).join("\n");
```

`src/search/hybrid.ts:169-181` — fusion weights + 3× name boost:
```ts
const HYBRID_ALPHA = 0.2; // 20% BM25, 80% TF-IDF
const NAME_BOOST_REPEAT = 3;
...
for (const t of tools) {
  const boosted = `${Array(NAME_BOOST_REPEAT).fill(t.name).join(" ")} ${t.text}`;
  this.bm25.add(t.name, boosted);
  this.tfidf.add(t.name, boosted);
}
```

## Maintenance signals

- **Version**: `0.4.0`. devDeps pin `ai ^6.0.141`, `@ai-sdk/openai ^3.0.49`, `typescript ^6.0.2`, `@types/node ^25.5.0` — current-generation AI SDK (v6).
- **Recency / history**: single squashed commit `3c49fe2`, 2026-03-31. No multi-commit history in this clone to judge cadence.
- **Tests**: substantial — **12 test files** under `src/test/` (tool-index, prepare-step middleware, hybrid, fusion, semantic-blind, rerank-blind, query-extractor, edge-cases, real-world, generate-text-e2e, features, utils), ~2200 LOC of tests vs ~1100 LOC of source. Run via `bun test`. Includes an e2e `generateText` test and "blind" eval tests for semantic/rerank.
- **Build**: `tsup` → ESM-only (`dist/index.js`), types emitted, `./` + `./eval` exports. `engines.node >=18`.
- Total source ~1115 LOC across 17 non-test files — small, focused, single-author.

## Relevance to kuralle

Directly relevant to dynamic `activeTools` selection if kuralle ever exposes large tool sets per node/agent. It is AI-SDK-native to the bone (consumes `PrepareStepFunction`, `LanguageModelMiddleware`, `embed*`, `cosineSimilarity`, `Output`, `tool`), so it slots into the same `prepareStep`/`activeTools` surface kuralle already builds on. The free hybrid BM25+TF-IDF tier (zero API calls) and fail-soft layering (combined→hybrid, rerank→candidates) are reusable patterns. Caveat: MIT asserted only in package.json — no LICENSE text file shipped.
