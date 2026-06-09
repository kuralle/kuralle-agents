# Adoption Plan — Midday AI-SDK Tooling → kuralle

**Decision posture:** opinionated and committed. No "it depends" without a named axis. Adopt-as-dependency is rejected across the board; **two patterns get ported this sprint**, two are deferred ports, four are study-only.

---

## 1. Ranked comparison

Ranked by *adopt-now leverage* (live-gap severity × seam cleanliness × invariant safety), not by the verdicts' flat P3.

| # | Candidate | Solves real gap? | kuralle seam | Decision | License | Effort | Prio | Verdict (one line) |
|---|---|---|---|---|---|---|---|---|
| 1 | **ai-sdk-heal** | Latent (live the moment handoff filters wire) | `applyPromptCache` pipeline (promptCache.ts:197 / TextDriver.ts:78) + `handoffFilters.ts:45` | **port-pattern** | **MIT (full text ✓✓)** | M | **3 → ship first** | Port the pairing-integrity invariant + reasoning-signature guard into core; reject the middleware form and the stub-result rule. |
| 2 | **hyper** | **YES** (zero MCP surface) | new `createKuralleMcpRouter` in hono-server, projecting `AgentConfig.tools`/`globalTools` | **port-pattern** | **MIT (full text ✓✓)** | M | **3 → ship second** | Port opt-in default-deny projection + funnel-through-the-real-turn; write kuralle code, don't adopt `@hyper/mcp` (bound to `HyperApp`). |
| 3 | **ai-sdk-cache** | YES (no idempotent result cache) | `ToolExecutor.executeInner` around `def.execute` (:162) + new `cacheable` flag on defineTool | **port-pattern** | MIT (manifest only) | M | 3 (defer) | Port stable-serialize + `CacheStore` shape; opt-in per-tool, hashed keys, capture-and-replay emits. Not the Proxy/Tool-layer mechanism. |
| 4 | **ai-sdk-devtools** | YES (no inspector) — DX not correctness | subscribe `TurnHandle.events` / parse `KuralleDataParts` (uiMessageStream.ts) | **port-pattern** | MIT (manifest only, LICENSE missing) | M | 3 (defer) | Port ~3 framework-free utils over `HarnessStreamPart`; drop fetch-monkeypatch, MUI/xyflow, chars/4 estimate. |
| 5 | **ai-sdk-artifacts** | No (already shipped via `emit('custom')`) | typed variant of `stream.ts` custom part + widget `useArtifact` | **port-pattern** | MIT (manifest only, LICENSE missing) | M | 7 | Port the typed+versioned envelope onto the existing transient channel *when a widget consumer needs it*. Capability already exists. |
| 6 | **toolpick** | No (kuralle tool sets are small/node-scoped) | `resolveTools()` in TextDriver (turn-stable subset only) | **study-only** | MIT (manifest only) | M | 5 | Borrow `select()` tiering *if* telemetry shows a node >~30 tools; embedding-only, turn-stable. Reject `prepareStep` paging + BM25 default. |
| 7 | **ai-sdk-memory** | No (core ships a strict superset) | none — plug points occupied (blocks + MemoryService) | **study-only** | **NONE (adopt-BLOCKED)** | S | 5 | Live-reinject model regresses prompt-cache; core's frozen-snapshot is better. Nothing to port. |
| 8 | **ai-sdk-agents** | No (ADR 0007 handoff-as-tool is superior) | `hostControlTools.ts` / `hostLoop.ts` already implement it | **study-only** | MIT (manifest only) | S | 9 | Only delta is `matchOn` lexical routing — the exact anti-pattern ADR 0007 deleted. Validation datapoint only. |

Legend: license "✓✓" = full LICENSE text shipped, verified two ways firsthand. "manifest only" = MIT in `package.json` with no LICENSE file → may not vendor code, may port the idea. "NONE" = no license anywhere → all-rights-reserved → adopt-BLOCKED.

---

## 2. Per-candidate verdict (opinionated)

### 1. ai-sdk-heal — PORT NOW (ship first)
**Pick:** Port the pairing-integrity invariant and the Anthropic/OpenAI reasoning-signature guard into core's own primitives. **Do not** adopt the package; **do not** use `withHealing`/`healMiddleware`; **do not** port the `stub-result` rule.

**Why.** The acute gap is *latent, not live* — and that is precisely why it's #1: it is a loaded gun, not a flesh wound. Kuralle's hot path keeps tool pairs intact (TextDriver pushes the assistant tool-call + tool-result PAIR together inside the turn), and `recoverFromContextOverflow` strips a clean suffix after the last user message (pairing-safe by construction). The *one* orphan-capable code path — `removeToolHistory`'s "preserve mixed assistant message" branch (handoffFilters.ts:45) — can keep a tool-call while dropping its `role:'tool'` result. It is **dormant**: `HandoffInputFilter` is typed on `Route`, exported, and **never invoked** (verified — `select.ts`'s only `.filter` calls are array ops on `flows`/`routes`/`parts`, not filter dispatch). Handoff filters exist *precisely to be wired*; the day they are, kuralle emits orphaned tool-calls to providers → 400s in production handoff flows, with zero healer. ai-sdk-heal is the only candidate with a full verified MIT LICENSE *and* the highest-stakes invariant exposure — so it leads.

**What to port, exactly:** (a) a shared `assertNoOrphans`/pairing-drop used by `removeToolHistory` and `keepRecentMessages` — when a tool-result is cut, drop its tool-call, and vice-versa (heal's idempotent pure-function shape, MIT, is the reference); (b) the missing-reasoning-signature / trailing-reasoning presence check as a thin pre-flight folded into `applyPromptCache`'s pipeline, gated by `inferProvider` — **only after a live 400 is reproduced** (CLAUDE.md §10: build the failing-prompt repro first). **Reject** heal's `orphanToolUse: "stub-result"` default outright: fabricating an `"assume the operation failed"` tool-result *lies* about a call kuralle's effect log may durably complete on retry. Kuralle **drops** the orphaned call (keeps the prefix honest); it never stubs a fake failure.

**Why not adopt-lib:** the `withHealing` middleware mutates the prompt *inside* `wrapLanguageModel`, **after** kuralle computed cache breakpoints — slugging names, inserting stubs, reordering — silently shifting the cached prefix and breaking the ~50–75% cost win. Only the pure `healMessages` form (run *before* `applyPromptCache`) is compatible, and even then stub insertion would alter a `cacheControl`-bearing message. Plus a non-optional hard peer on `ai >=5.0` and provider rule-tables kuralle would keep in lockstep — poor surface/value ratio for a small port.

### 2. hyper — PORT NOW (ship second)
**Pick:** Port the MCP-projection *pattern* into a kuralle-native `createKuralleMcpRouter`. **Do not** adopt `@hyper/mcp` (structurally bound to `HyperApp` + `app.invoke()` route-dispatch, which kuralle does not have).

**Why.** This is the **only candidate solving a real, live, framework-wide gap** with a clean license. Grep of all `packages/*/src` for `mcp|modelcontextprotocol` = **0 hits** — kuralle has neither MCP client nor server. As agent-to-agent interop standardizes on MCP, a kuralle agent cannot today be a callable tool-provider for an external orchestrator. It's greenfield (a new capability, not a fix), which is the only reason it ranks behind heal's loaded gun. License is full MIT (Midday Labs AB), verified firsthand — the task brief's "no license" flag was *wrong*.

**What to port, exactly:** (1) **opt-in projection, default-deny** — `if (!r.meta.mcp) continue` becomes "only tools explicitly marked MCP-exposed surface" (matches kuralle's `globalTools` allow-list discipline; keeps consequential/flow-gated tools OUT); (2) the minimal JSON-RPC 2.0 `initialize`/`tools/list`/`tools/call` shape; (3) **funnel-through-the-real-pipeline** — `tools/call` runs a real durable tool turn (NOT a raw re-dispatch), so middleware/validation/effect-log run exactly as a normal turn; (4) `--audit` to dump the exposed surface + inferred auth before shipping.

**Two improvements over hyper:** hyper's `inputSchema` is *coarse* (object-presence only, no Standard Schema inlined) — kuralle should **inline the tool's Standard Schema JSON Schema** (we already have `z.toJSONSchema` from the zod4 migration, used in gemini.ts:22) for a real contract. And hyper derives tool *names* from `<method>_<path>` — kuralle must derive from the tool's declared `name`/`description`, never from lexical inspection (ADR 0007: no lexical-routing backdoor).

### 3. ai-sdk-cache — PORT (defer behind heal+hyper)
**Pick:** Port the stable React-Query-style serialization and the `CacheStore` interface shape onto kuralle's existing Memory/Redis/Postgres backend pattern, as a **separate exact-key tool-result cache** gated by a new opt-in `cacheable`/`cacheTtl` flag on defineTool. **Do not** adopt the code (no LICENSE file; zero tests; raw unhashed keys; `setWithTTL` never called so Redis entries linger; unrestored writer monkey-patch).

**Why defer, not P1:** durability already prevents the *dangerous* case — double-execution on retry is covered by the effect log. This is a cost/latency optimization for *idempotent* tools (same `knowledge_search` query under a different `toolCallId` re-executes today), not a correctness fix. Two correctness traps mandate care: (a) caching a side-effecting tool would silently skip the durable write — so cache is **opt-in per-tool, read-only/idempotent only**; (b) a cache hit skips `def.execute` and therefore `ToolContext.emit` — so we must **capture-and-replay emitted `HarnessStreamPart`s on hit**, or grounding/citation events vanish (a grounding-contract regression). Keys must be **hashed** (PII-in-key on Redis otherwise). Note: this is **not** the ADR-0008 deferred grounding-cache slot (knowledge.ts:59) — that wants a *semantic* embedding cache; exact-string keys give near-zero hit-rate on multilingual knowledge queries. Wrong cache species for grounding; right one for durable tools.

### 4. ai-sdk-devtools — PORT (defer, DX not correctness)
**Pick:** Port ~3 framework-free utilities (ring-buffer + per-type throttle collector; `groupEventsIntoSessions` keyed on `toolCallId`/`nodeName`; the pass-through-tee principle for any out-of-process case) reimplemented over `HarnessStreamPart`, and build a thin kuralle-native inspector. **Do not** adopt (no LICENSE file; zero tests; ~4400 LOC of MUI + xyflow + dagre + emotion).

**Why.** Real R-01 observability gap, but dev-time DX, not runtime correctness → improvement-priority. Kuralle already does the hard half: `harnessToUIMessageStream` maps every `HarnessStreamPart` into typed `data-kuralle-*` parts (uiMessageStream.ts), and `TurnHandle.events` exposes the same union in-process as a typed `AsyncIterable`. So **drop** the fragile bits: the `window.fetch` monkey-patch (subscribe `TurnHandle.events` directly), the `chars/4` token estimate (read real usage via the metrics bridge — porting the estimate would introduce a *second, wrong* number), and the heavyweight React/MUI shell. Drive the parser off **kuralle's own** `HarnessStreamPart` union (20+ members incl. safety/interactive/outcome), never the devtools' 30-member AI-SDK union.

### 5. ai-sdk-artifacts — PORT (low priority, P7)
**Pick:** Port the typed+versioned `ArtifactData<T>` envelope and progress lifecycle onto the existing `emit('custom')` channel + a `useArtifact` hook in `kuralle-widget` — **when a widget consumer actually needs progressive structured UI**. Until then, study-grade.

**Why.** Mostly already solved. Kuralle ships the exact mechanism: `ToolContext.emit` (run-context.ts:113), `HarnessStreamPart` `{type:'custom'}`/`{type:'interactive'}`, mapped to `data-kuralle-custom`/`data-kuralle-interactive` (ADR 0005). The only delta is *ergonomic*: a zod-typed envelope, monotonic versioning + client history, a typed React hook. That's a DX nicety on a non-core surface, not a capability gap. Adopt-blocked anyway (no LICENSE file; zero tests; stale README referencing a non-existent `createTypedContext`; examples that throw at runtime on wrong `.stream()` arity). Keep any port **transient** — making the artifact part persistent would inflate the cached prefix and double-count under exactly-once.

### 6. toolpick — STUDY ONLY
**Pick:** Study the `select()` tiering ideas (over-fetch, threshold, adaptive elbow, `alwaysActive`, `expandRelated`) and the eval-harness shape. Build a kuralle-native filter **only when telemetry shows a node >~30 tools** — embedding-only, turn-stable. Do not vendor.

**Why study not adopt:** four independent blocks. (1) License manifest-only. (2) **Direct fight with 0.7.2** — `prepareStep` *varies* `activeTools` per step (pages on misses, exposes-all after 2 failures); tools are in the cacheable prefix, so per-step churn forfeits the measured ~50% input-cost cut. (3) **ADR 0007** — defaults to hand-rolled BM25+TF-IDF (`HybridSearch`), the exact lexical surface the ADR outlawed for multilingual voice. (4) The real gap (large flat `globalTools` on one node) is *uncommon* by design — ADR 0007 + SOP-in-flows already does which-procedure/which-agent reduction structurally, so nodes rarely reach the ~30–50 tools where ranking earns its keep. Any kuralle filter must decide the subset **once per turn in `resolveTools`** and keep it byte-stable across the `maxSteps` loop. See §5.

### 7. ai-sdk-memory — STUDY ONLY (adopt-BLOCKED)
**Pick:** Confirm nothing in its surface is missing from core, then move on. Nothing to port.

**Why.** Two independently disqualifying facts. (1) **No license anywhere** (package, dir, root all empty) → all-rights-reserved → adopt-BLOCKED; code may not be copied. (2) Even clean-licensed, it's a strict *subset*: working-memory-as-markdown-blob == kuralle's `PersistentMemoryBlock` + `memory_block` tool, but kuralle adds scopes/char-limits/injection-scanning/4 backends; recency history == `SessionStore`; and the one thing memory lacks (vector/semantic) is exactly what `MemoryService.searchMemory` provides. Worse, memory's design has the model **rewrite the whole blob each turn and re-inject `getWorkingMemoryInstructions` live** — that mutates the cached prefix every turn and busts Anthropic prompt-cache hits. Kuralle's **frozen-snapshot** pattern (inject once, mid-session writes hit disk, model reads its own writes via the tool's `view` action) is strictly better. Adopting would *regress* 0.7.2.

### 8. ai-sdk-agents — STUDY ONLY
**Pick:** Record one validation datapoint — an AI-SDK-native peer independently converged on handoff-as-tool, confirming kuralle's direction. Import nothing.

**Why.** Kuralle already shipped the strictly-superior version (ADR 0007 / `hostControlTools.ts` + `hostLoop.ts`): `z.enum` target schema, semantic descriptions, lazy answer-adequacy `hostControlGuard`, durable run-state persistence, exactly-once via `executeHostControl`. ai-sdk-agents is in-memory `currentAgent` reassignment + `usedSpecialists` Set + **0 tests** (3170 LOC). Its only delta — `matchOn` programmatic/lexical routing — is the precise anti-pattern ADR 0007 banned. See §5.

---

## 3. Sequenced ship plan

Gated, smallest-blast-radius-first. Each step has a verify gate (CLAUDE.md §4).

```
STEP 0 — Reproduce the loaded gun (gate for STEP 1)
  Build a failing-prompt repro: wire removeToolHistory across a handoff,
  capture the orphaned-tool-call ModelMessage[], send to Anthropic → observe 400.
  → verify: a deterministic, agent-runnable test that goes red with today's code.
  (Per CLAUDE.md §10 — no fix before the loop.)

STEP 1 — ai-sdk-heal port  [unblocks the day handoff filters wire]
  1a. Shared assertNoOrphans + pairing-drop in handoffFilters.ts
      (removeToolHistory + keepRecentMessages both call it).
  1b. ONLY IF STEP 0 reproduced a reasoning-signature 400:
      reasoning-signature presence pre-flight folded into applyPromptCache's
      pipeline, gated by inferProvider. Runs BEFORE cache markers; never
      touches the last cached messages' identity.
  → verify: STEP 0 test goes green; prompt-cache hit-rate unchanged
            (assert cached-token count stable on turns 2-4); ADR-0007 untouched
            (heal is purely structural).
  → REJECTED in this step: stub-result rule, withHealing middleware.

STEP 2 — hyper MCP projection port  [greenfield, independent of STEP 1]
  2a. createKuralleMcpRouter({ runtime }) in kuralle-hono-server/src/,
      mounted beside createKuralleChatRouter, re-exported via CF (cf-agent).
  2b. Opt-in default-deny projection from AgentConfig.tools/globalTools,
      inputSchema inlined via z.toJSONSchema (zod4).
  2c. tools/call funnels through a real durable tool turn (effect-log keyed),
      requires session + idempotency key for any mutating exposure;
      read-only/globalTools-class default. Per-call cfg.authorize gate. --audit.
  → verify: live smoke — external MCP client lists tools, calls a read-only
            tool, gets a schema-valid result; a retrying call does NOT
            double-execute a mutating tool (effect-log assertion);
            an unexposed tool is invisible.

STEP 3 — ai-sdk-cache port  [defer; after STEP 1+2 land]
  defineTool gains cacheable/cacheTtl; cache lookup keyed by
  (toolName + hashed stable-serialize(sanitizedArgs)) in ToolExecutor.executeInner,
  BEFORE def.execute, populated after validateOutput; capture-and-replay emits.
  → verify: idempotent tool with cacheable:true hits cache across toolCallIds
            AND replays its knowledge-search emit events on hit; a side-effecting
            tool without the flag is never cached; Redis keys are hashed.

STEP 4 — ai-sdk-devtools port  [defer; DX]
  ~3 framework-free utils over HarnessStreamPart + thin inspector on TurnHandle.events.
  → verify: inspector renders text/tool/flow/handoff/safety events from a live turn
            with zero request-path mutation; token counts come from the metrics bridge.

LATER / CONDITIONAL
  ai-sdk-artifacts (P7): port typed envelope when a widget needs progressive UI.
  toolpick: build embedding-only turn-stable filter IFF telemetry shows a node >~30 tools.
```

**Why this order:** STEP 1 carries the highest-stakes invariant exposure (production 400s) and the cleanest license; STEP 2 is the only live framework-wide capability gap; both are M-effort, MIT-verified, and independent (parallelizable). STEP 3/4 are optimizations/DX behind correctness. STEPs 5+ are conditional on telemetry or consumer demand.

---

## 4. Flip conditions (for the two adopt-now ports)

Explicit triggers that would change the decision.

### ai-sdk-heal
- **Flip port → adopt-lib** if: kuralle drops 0.7.2 prompt caching entirely (removing the post-cache-mutation conflict) AND wants to track the full provider-rule matrix (orphan/name/input/dedupe/reasoning across 4 providers) AND is willing to take a hard `ai >=5.0` peer. Then `healMessages` (pure form, run pre-`applyPromptCache`) becomes a defensible dependency. *Today: false on all three.*
- **Flip port → skip** if: a decision is made to **never** wire `HandoffInputFilter`/`removeToolHistory` (delete the dormant code instead). Then the only orphan-capable path is gone and the pairing-port has no live target. *Recommend against — the filters exist for a reason; keep the port.*
- **Pull STEP 1b forward (priority up)** if: a live Anthropic extended-thinking-signature 400 reproduces on the new prompt-cached multi-turn path *before* handoff filters wire. That makes the reasoning-guard live, not latent.

### hyper
- **Flip port → adopt-lib** if: kuralle ever adopts `HyperApp`'s route-dispatch primitive (it won't — kuralle's unit is the agent turn, not an HTTP route). *Structurally impossible without abandoning the agent model.*
- **Flip port → skip** if: the MCP spec is superseded by a different agent-interop standard before STEP 2 ships, OR product decides kuralle agents will only ever be MCP *clients*, never *servers*. *Monitor the spec; greenfield work should track the live standard.*
- **Escalate priority (P3 → P1)** if: a concrete consumer needs to expose a kuralle agent as an MCP tool-provider to an external orchestrator this quarter. Greenfield interop currently sits behind shipped-defect work and the config→running-agent prod wire (MEMORY keystone gap); a real consumer flips that.

---

## 5. Two cross-cutting tensions (named axes, no hand-waving)

### Tension A — toolpick `prepareStep` vs 0.7.2 prompt-cache prefix stability
**Axis: *when* the active tool-set is decided — per-step vs per-turn.** This is a **HARD conflict**, and it is decidable, not "it depends."

Tools live in the **cacheable prefix** (Anthropic `cache_control` spans system+tools; OpenAI auto-caches the longest stable prefix). 0.7.2 measured ~10240 cached tokens / ~99% of prompt / ~50% input-cost cut on turns 2–4 by keeping that prefix byte-stable. Toolpick's entire `prepareStep` design **varies `activeTools` per step** — it pages to the next candidate window on a miss, and exposes *all* tools after 2 consecutive failures. Every tool-set change on a step invalidates the system+tools cache span → cache miss → the ~50% saving is forfeited on exactly the multi-step turns where it matters most. No type-check catches this; it's a silent $ regression.

**Resolution (committed):** a kuralle tool-filter, *if ever built*, decides the subset **once per turn inside `resolveTools()`** (TextDriver, ~:286, where the full `aiTools` ToolSet is built once and held stable across the `maxSteps` loop, :77–86) and keeps it **byte-stable across the whole loop**. `prepareStep`-style per-step churn is rejected. The model loses mid-turn tool-discovery; it keeps the cache. That trade is correct because kuralle's tool sets are small and node-scoped — the discovery benefit is marginal, the cache benefit is measured and large. (toolpick's `search_tools` meta-tool is a possible escape hatch for the rare miss, since calling a tool doesn't mutate `activeTools`.)

### Tension B — ai-sdk-agents `matchOn` vs ADR 0007 multilingual constraint
**Axis: *what decides the route* — lexical surface vs derived structural shape.** This is a **DIRECT conflict** with a banned pattern, and it's not close.

`matchOn` routes by `input.toLowerCase().includes(pattern)` / `RegExp.test(input)` — code-side, first-match, **no LLM** (agent.ts:618–630). ADR 0007 §E *deleted* exactly this (`deterministicRouteMatch`/`keywordRouteFallback`) because keyword-table/regex matching breaks multilingual voice routing: a French or paraphrased-English utterance of the same intent silently fails the English-keyword match. ADR 0007 §2 also bans routing *modes* (a `matchOn` fast-path is a permanent fork — the single-mechanism/derived-shape rule).

**Resolution (committed):** kuralle keeps its derived host-control routing — handoff-as-tool with `z.enum` targets + semantic descriptions, the model deciding via a synthetic tool (`hostControlTools.ts`/`hostLoop.ts`), durable via `executeHostControl`. `matchOn` is **not ported in any form**, not even as a text-only fast-path. The validation worth keeping: ai-sdk-agents independently arrived at handoff-as-tool (its `HANDOFF_TOOL_NAME` + `z.enum` target == kuralle's pattern), confirming kuralle's direction — but its *lexical* layer is the precise thing kuralle correctly removed. Porting `matchOn` would be a regression against ADR 0007, full stop.

---

## 6. Bottom line

**Two adopt-now ports** (`ai-sdk-heal` pairing-integrity, `hyper` MCP-projection) — both MIT-verified, M-effort, independent, and the only two clearing license + live/loaded-gap + invariant-safety together. **Five further ports** are deferred (cache, devtools, artifacts) or conditional (toolpick) — good ideas, manifest-only licenses, behind correctness work. **Two are pure study** (memory adopt-BLOCKED + already-superseded; agents already-superseded). The dependency-adoption hypothesis is falsified; the directional hypothesis ("kuralle is on the right line") is confirmed by how often these peers reinvent what core already ships better.
