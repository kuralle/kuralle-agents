# ADR 0008 — On-demand retrieval (who invokes grounding)

**Status:** Accepted · **Date:** 2026-06-09 · **Builds on:** [ADR 0007 — Derived host routing](./0007-derived-host-routing.md)

## Context

Retrieval-augmented grounding in Kuralle is **pre-injection** (CAG-style): `runGatherPhase` (`runtime/grounding/gather.ts`) runs `ctx.autoRetrieve.retrieve(...)` *before* `streamText` and folds the result into the system prompt. `ctx.autoRetrieve` is built per agent and is present **iff the agent declared `knowledge`** (`buildAutoRetrieveProvider` returns `undefined` otherwise). So a declared-knowledge agent retrieves before **every answering turn**.

After ADR 0007, an **answering agent folds routing (`enter_flow` / `transfer_to_agent`) into its speaking turn**. That fuses two jobs into one turn:

- **the route decision** — needs *no* knowledge; it reasons over flow/agent descriptions, and
- **the answer** — needs knowledge.

Pre-injection grounds **both**. So on the fraction of host turns that *route* instead of answer, the agent paid the retrieval latency (a 50–150ms Layer-3 search, sequential before the first token) for context it never used — and delayed the routing decision behind a retrieval it didn't need. This is the sibling-repo finding "`autoRetrieve` fires on flow-entry turns = wasted RAG."

The only latency-free way to stop a routing turn from paying the retrieval tax is to retrieve **when the agent decides to answer**, not before it decides anything — i.e. let the model invoke retrieval as a tool. That makes grounding *model-discretion* (skippable), which is fine for agents that don't promise always-grounded answers and is the right tradeoff for triage/dispatch-heavy agents.

Pure dispatchers are already unaffected: `runPureDispatcher` (`hostLoop.ts`) classifies via `generateObject` and never calls `driver.runAgentTurn`, so it never reaches `runGatherPhase`. The cost lives only on the **answering** host turn.

### What we are NOT doing, and why

- **No pre-classify to gate retrieval.** We can't know in advance whether a fused host turn will answer or route, and pre-injection must happen before generation. Gating it on intent requires a pre-classify model call — re-adding exactly the per-turn latency tax ADR 0007 deleted. Regressive.
- **No new `mode` enum.** An earlier draft added `knowledge.mode: 'guaranteed' | 'on-demand'`. That is the *same* anti-pattern ADR 0007 rejected for `routing.mode`: a behavior-forking flag that multiplies the test matrix and contradicts *"behavior is derived from which fields you populate."* Worse, a 1-of-2 enum makes pre-injection and a search-tool **mutually exclusive by fiat** when they are independent capabilities. And it adds a brand-new field for an axis that **already has one**: `knowledge.autoRetrieve`. The real defect was never a missing mode — it was that `autoRetrieve: false` left knowledge **inert** (declared, nothing wired) instead of handing retrieval to the model.

## Decision

**Keep `knowledge.autoRetrieve: boolean`. It declares *who invokes* retrieval — the runtime or the model. Fix its `false` branch to wire the tool instead of going inert.**

```ts
interface AgentKnowledge {
  /** Whether the runtime retrieves automatically. Default: true.
   *  true  (guaranteed) — pre-inject before every answering turn.
   *  false (on-demand)  — wire a `knowledge_search` tool; the model retrieves
   *                       only when it answers (routing turns pay no tax). */
  autoRetrieve?: boolean;
  sources?: string[];
}
```

### A. `autoRetrieve: true` (default) — unchanged
`buildAutoRetrieveProvider` builds the pre-injection provider exactly as before; `ctx.autoRetrieve` is set; `runGatherPhase` pre-injects on every answering turn. The entire existing surface is byte-for-byte unchanged. **Not a breaking change.**

### B. `autoRetrieve: false` — on-demand, zero routing tax
- `buildAutoRetrieveProvider` returns `undefined` (as it always did) → no pre-injection.
- **New:** `buildKnowledgeTool(provider, agent)` (co-located in `runtime/grounding/knowledge.ts`) builds a core `knowledge_search` tool, wired into the durable executor (`agentTools`) **and** `runCtx.globalTools` (model-visible every turn, host answer and flow nodes). It is built **only** when `autoRetrieve === false`. The tool closes over the in-core `KnowledgeProvider`; core gains **no** dependency on `@kuralle-agents/rag`. It **returns data only** (retrieved document texts; no prose — per the tool-output rule) and emits `knowledge-search` events via `ToolContext.emit`.
- A routing turn emits `enter_flow`/`transfer_to_agent` and never calls the tool → **no retrieval, no added latency**. An answering turn calls it when it needs grounding.

The provider and the tool are **mutually exclusive by the boolean** — exactly one is active. An honest either/or (runtime-invoked vs model-invoked), not a synthetic enum. If a future need for "compiled base + search tool together" appears, that is an additive change, not a reason to fork now.

### C. Node-level opt-out is a separate axis (untouched)
The per-node `grounding.knowledge.autoRetrieve: false` (`NodeGrounding`, `flow.ts`) stays — it lets a node opt out of guaranteed pre-injection (e.g. a procedural `collect`/`confirm` node). It is a no-op when the agent is on-demand (nothing is pre-injected). It is a *different* type from the agent-level field and is not renamed.

### D. Handoff tool-surface rebuild (latent fix, completed)
The durable `toolExecutor` is built once at run-open for the opening agent and is intentionally **not** rebuilt on handoff (one effect log / enforcer history per run — rebuilding would reset exactly-once replay state). Per-agent tools therefore execute via the per-call `def`-injection path in `executeModelToolCall`. The original handoff path rebuilt only `runCtx.globalTools` and reused the *opening* agent's workspace/skill tools, so a handed-off agent's own workspace/skills/`memory_block` leaked or were unexecutable.

This is now fixed at the root: a single `buildAgentToolSurface(agent, session, deps)` helper (`runtime/buildAgentToolSurface.ts`) assembles an agent's **complete** surface — executor tools, model-visible `globalTools` (incl. `workspace`, skill tools, `knowledge_search`), `workingMemoryTools`, `workingMemoryPrompt`, `skillPrompt`, workspace `fs` — and is used by **both** run-open and handoff, so the target's full surface is rebuilt with **no opening-agent leakage**. The drivers pass `{ ...ctx.globalTools, ...ctx.workingMemoryTools, ...localTools }` (mirroring `resolveTools` visibility) so every model-visible tool is also executable. Verified behaviorally (`grounding-mode.test.ts`: a host→specialist handoff where the specialist's `workspace` reads its own FS, `host_only`/host skill are absent, and `knowledge_search`/`memory_block`/specialist tools all execute).

Proven-safe under adversarial review (codex, high reasoning): the `def`-injection path preserves **exactly-once** replay keyed by `toolCallId`; it does **not** bypass the approval gate (`ctx.tool` checks `options.def`) or the `ToolEnforcer`; the injected `toolCtx`'s omission of `fs` is harmless because the `workspace` tool closes over its `fs` via `createFsTool`.

## Consequences

- **New capability, zero-cost default.** Agents that route heavily declare `autoRetrieve: false` for fast dispatch; everyone else keeps guaranteed grounding with no change and no new field to learn.
- **Not breaking; no type change.** `autoRetrieve: true`/omitted is unchanged. The only behavior change is `autoRetrieve: false`: previously inert, now exposes `knowledge_search`. To disable retrieval entirely, omit `knowledge`.
- **On-demand citations / cache:** the tool path emits `knowledge-search` events via `ToolContext.emit`. Note the Layer-2 semantic cache is **not currently wired** into *either* path — `buildAutoRetrieveProvider` (guaranteed) and `buildKnowledgeTool` (on-demand) both pass `cache = undefined` to `provider.retrieve`, and there is no `retrievalCache` field on `RunContext` (the `KnowledgeProvider` comments referencing one are stale). Wiring a per-run retrieval cache is a separate, pending improvement that would benefit both modes.
- **Consistency with ADR 0007:** no behavior-forking config flag; the existing boolean expresses a genuine, non-derivable author intent (who invokes retrieval) as a typed contract — which is what *"make the concern a typed, first-class part of the model"* prescribes.
