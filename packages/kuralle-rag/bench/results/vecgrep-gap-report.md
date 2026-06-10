# VecGrep-gap sprint — measured net improvement

**Date:** 2026-06-10 · **Branch:** `sprint/vecgrep-rag-gap` · **Harness:** `bench/vecgrep-gap.bench.ts` (deterministic corpus: 200 docs / 1,200 chunks, seeded hash embedders) · Raw JSON: `vecgrep-gap-baseline.json`, `vecgrep-gap-after.json`.

## Headline results

| Metric | Baseline | After | Delta |
|---|---|---|---|
| **Unchanged-corpus re-ingest** (texts embedded) | 1,200 | **0** (with manifest) | −100% embed calls |
| Unchanged-corpus re-ingest (wall) | 55–69 ms (free embedder) | **12–17 ms** | hash checks only |
| **Same-dimension embedder swap** | overlap@5 = **0.00** vs truth, **0 errors** — silent garbage | **20/20 queries throw** a hard, named error | silent corruption → impossible |
| **Exact-term queries: grep tier** | 996 tok/query @ 80%→(corpus-order bug) | **126 tok/query @ 100% hit** | ~8× leaner, more accurate |
| Exact-term queries: semantic tier | 1,241 tok/query @ 80% hit | unchanged | grep tier is ~10× cheaper — now stated in tool descriptions |
| **Pipeline restart, keyword tier recovery** (1,200 chunks) | *silently empty* (manifest-skip never re-adds) | BM25 chunk-reseed 30 ms / **FTS5 10 ms** | correct by construction |
| Pipeline restart (9,000 chunks) | — | BM25 reseed 502 ms / **FTS5 119 ms** | ~4× at scale |
| **Query embedding latency** (live, OpenAI `text-embedding-3-small` from dev machine) | p50 **297 ms**, mean 444 ms, p95 2,905 ms per query | Workers AI via `env.AI` = in-network, no public-internet hop | *unverified live* (no CF creds in this env) — measure from a deployed Worker |

## What changed per work package

- **WP1 Provider lock** — `IngestManifest` records `{embedder.id, dimension}`; `RagPipeline` validates at ingest *and* retrieve. Baseline phase D proves the failure was real and silent (0.00 overlap, 0 errors); phase D2 proves it now throws on every call with a remediation message.
- **WP5 Incremental ingest** — SHA-256 content hash per doc; unchanged docs skipped (phase A2: 1,200 → 0 embeds), stale chunks of changed docs deleted from store + keyword index (tested).
- **WP4 FTS5 keyword tier** — `KeywordIndex` contract; `Fts5KeywordIndex` over a tagged-template `SqlExecutor` (DO SQLite on CF — FTS5 is supported there — or bun:sqlite/better-sqlite3 on Node).
- **WP3 Tier guidance** — workspace + retrieval tool descriptions order the tiers (ls/find → grep → semantic); `RetrievalQualityChecker` now reports `estimatedTokens`.
- **WP2 Workers AI path** — vectorize-store README now pairs Vectorize with `workers-ai-provider.textEmbeddingModel` (verified against `cloudflare/ai` source); the measured ~300 ms/query cloud-embed tax is what this removes.

## Defects found and fixed along the way

1. **`KnowledgeFs.search` rank-order bug** (pre-existing): BM25 ranked, but results were returned in corpus order and truncated — top-ranked hits could be dropped. Fixed (rank order, over-fetch before root filtering); this alone took the grep tier from 996→126 tokens/query at 100% hit rate. Regression test added.
2. **`BM25Index.size` counted tombstones** (pre-existing): removals/overwrites inflated `size`. Now counts active docs.
3. **Manifest-skip × in-memory keyword index** (introduced by WP5, caught by bench): after a restart, skipped docs were never re-added → empty keyword tier, hybrid silently degraded to vector-only. `RagPipeline.ingest` now chunk-reseeds (zero embeds) when the keyword index is empty; a persistent FTS5 index skips even that.
4. **Indic-script tokenization** (pre-existing): both `tokenizeKeywords` and FTS5 `unicode61` treated combining marks as separators, splitting Tamil/Sinhala/Hindi words at every vowel sign. Fixed: `\p{M}` kept in the shared tokenizer; FTS5 default is now `unicode61 categories 'L* N* Co Mn Mc'`. CJK/Thai supported via `tokenize: 'trigram'`. Tests cover Tamil, Sinhala, German, Japanese, Chinese.

## Honest caveats

- **`KnowledgeFs.open()` wake time is scan-dominated**: at 1,200–9,000 chunks the BM25 reseed rides the store scan and costs ~10 ms of CPU — FTS5 is *parity*, not a win, on that specific path. The FTS5 win is the **pipeline/FusionRetriever restart path** (no free text scan; 4× faster at 9k chunks and no reseed writes) and **correctness under manifest-skip**.
- **Workers AI in-network latency is asserted, not measured** — this environment has no Cloudflare credentials. The cloud-side baseline (p50 297 ms/query) is measured; the comparison number needs a probe inside a deployed Worker.
- WP3's effect on *model behavior* (choosing grep before semantic) is a prompt-level change; the bench measures the token economics of the tiers, not model tool choice. An eval scenario would close that loop.
- Token counts use the ~chars/4 estimate, consistently on both sides.
