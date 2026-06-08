# Migrating from Kuralle v1 to v2

Kuralle **2.0** (`core-v2`) is a breaking rewrite of `@kuralle-agents/core`. There is no
compatibility layer: v1 sessions, pack JSONC, and the graph-interpreter runtime do not
carry forward.

Use this guide with the **2.0.0** section in [`CHANGELOG.md`](./CHANGELOG.md).

---

## Recommended upgrade order

1. Bump to `@kuralle-agents/core@2` and run `tsc` — fix compile errors from removed classes and methods.
2. Run the [authoring codemod](#codemod-v2-scope) on agent/flow TypeScript sources; fix everything it flags for hand review.
3. Reshape `HarnessConfig` to the [9-field v2 shape](#harnessconfig-v1--v2) and move per-agent settings onto `AgentConfig`.
4. Replace procedures with [flows + durable tools](#procedures--flows--ctxtool).
5. Replace JSONC packs with programmatic `defineAgent()` configs (config/builder packages removed).
6. Rewire observability from [20 v1 hooks → 5 v2 hooks](#hooks-20--5).
7. Update runtime call sites (`chat` → `run`, session store access, abort naming).
8. Re-test behaviors that v1 handled automatically (compaction, safety moderators, hybrid detours) — they are **removed**, not silently equivalent.

---

## Authoring: one agent primitive

| v1 | v2 |
|----|-----|
| `new Agent()` / `FlowAgent` / `TriageAgent` / `CompositeAgent` | `defineAgent({ ... })` → `AgentConfig` |
| `type: 'llm' \| 'flow' \| 'triage' \| 'composite'` | **Removed** — behavior from populated fields |
| `prompt` | `instructions` |
| `canHandoffTo` | `handoffs` |
| `flow: FlowConfig` (god-object nodes + `transitions[]`) | `flows: Flow[]` with `reply` / `collect` / `action` / `decide` nodes; transitions are **returned node references** |
| `FlowManager`, `FlowGraph`, `FlowGraphBuilder` | `defineFlow()`, `runFlow()` inside `hostLoop` |
| `new Runtime(config)` | `createRuntime(config)` |

**Flows:** v1 `FlowNodeConfig` combined prompt, model, tools, pre/post actions, and edges. v2 nodes are single-job. v1 `expression` / `condition` edges become handler logic that returns the next node (e.g. `reply.next(turn, state)`).

**Triage:** v1 `triageMode: 'llm' \| 'structured'` is gone. v2 routing uses schema-only `generateObject` via `selectHostTarget` / `routes` — equivalent to v1 **structured** triage only.

**Composite:** v1 `CompositeAgent` owned a private agent map; v2 flattens `agents[]` into the runtime index and uses the top-level `hostLoop` for handoffs.

---

## HarnessConfig (v1 → v2)

v2 `HarnessConfig` (`packages/kuralle-core/src/runtime/Runtime.ts`) has **nine** fields:

| Field | Notes |
|-------|--------|
| `agents` | `AgentConfig[]` from `defineAgent()` |
| `defaultAgentId` | Entry agent id |
| `sessionStore` | Optional; defaults to in-memory |
| `defaultModel` | Optional fallback model |
| `maxHandoffs` | Optional; default `5` |
| `hooks` | v2 [`Hooks`](#hooks-20--5) only |
| `voiceMode` | Voice-oriented defaults |
| `hostSelect` | Optional override for host selection |
| `tools` | Global durable effect tools (`defineTool`) |
| `knowledge` | Knowledge provider config |
| `memoryService` | Long-term memory service |

Everything else that lived on v1 `HarnessConfig` is **removed**, **moved to per-agent `AgentConfig`**, or **reshaped** as below.

### Removed from HarnessConfig (no v2 equivalent)

| v1 field | Notes |
|----------|--------|
| `autoCompaction` | Background/truncate/summarize compaction — **deleted** (Group A). Long sessions need an app-level strategy. |
| `keyFacts` | Per-turn fact extraction into working memory — **deleted** (`KeyFactsExtractor`). |
| `promptCache` | OpenAI prompt caching helpers |
| `openaiResponses` | Responses API wiring |
| `persistentMemory` | Use `memoryService` + agent `memory` instead |
| `auxiliaryModels` | Cheap models for side tasks |
| `turnTimeoutMs` / `zeroTokenTimeoutMs` | Turn/token timeouts |
| `handoffInputFilter` | `handoffFilters` utilities still exported; not auto-applied |
| `safety` | Output moderator chain — **deleted** (`RegexPiiModerator`, `JailbreakEchoModerator`, `LlamaGuardModerator`, Group A) |
| `escalation` | Confidence escalation — **deleted** (`ConfidenceRefinement`, `buildEscalateToHumanTool`, Group A) |
| `refinement` / `validation` | Capability lists on harness — use `AgentConfig.guardrails` |
| `outcomes` | `autoAbandonAfterMs` sweeper config on harness |
| `personaExperiment` | A/B persona allocation |
| `extractionModel` / `routingModel` | Harness-level model overrides |
| `maxSteps` | Now `AgentConfig.limits` only |
| `policyProfile` / `policyInjections` | **Deleted** (`InjectionQueue`, `policyProfiles`) |
| `streamCallback` / `callback` | **Deleted** (HTTP/file/function stream sinks) |
| `stopConditions` | Guards still exported; not wired from harness |
| `enforcementRules` | Use `AgentConfig.guardrails.enforcement` |
| `contextManager` | **Deleted** (`ContextManager`, `createContextManager`) |
| `contextBudget` | Budget helpers exported; not accepted on harness |
| `sessionCache` | **Deleted** |
| `audit` | `AuditCollector` **deleted**; `replayAuditLog()` remains if the store holds audit entries |
| `layeredPrompting` | Layered prompt assembly config |
| `deferPersistence` | Deferred session writes |
| `channels` | Multi-channel `conversationStore` / policies on harness |
| `alwaysRouteThroughTriage` / `triageAgentId` | Removed — pure dispatchers classify every turn; answering agents use host-control tools + guard |
| `retriagePolicy` | Retriage rules |
| `outputRedaction` | Regex redaction on streamed assistant text |
| `telemetry` | Harness-level telemetry |
| `suggestionModel` / `suggestionCount` / `suggestionPrompt` | **Deleted** (`SuggestionManager`) |
| `inputProcessors` / `outputProcessors` (global) | **Moved** → `AgentConfig.guardrails` |
| `promptMemoryAllowlist` (global) | **Moved** → `AgentConfig` (when used) |
| `memoryIngestion` / `preloadMemory` | Ingestion hooks on harness |
| `harnessNormalize` | **Deleted** — v1 config normalizer |

### Moved to per-agent `AgentConfig`

| v1 (harness or agent) | v2 `AgentConfig` |
|------------------------|------------------|
| Global `inputProcessors` / `outputProcessors` | `guardrails` |
| Global `enforcementRules` | `guardrails.enforcement` |
| `promptMemoryAllowlist` | Same field on agent (if needed) |
| `maxSteps` | `limits` |
| `alwaysRouteThroughTriage` | (removed — see ADR 0007 derived host routing) |
| `triageAgentId` | Implicit via `routes` / default agent |
| `telemetry` | **Removed** from agent type (Group A) |

### Removed from `AgentConfig` (Group A — dead v2 surface)

These were declared in v1 / early v2 types but are **not implemented** and were **deleted** in cleanup A:

| Field | Replacement / note |
|-------|---------------------|
| `escalation` | No built-in confidence escalation in v2 |
| `extraction` | Use `collect` nodes / `ctx.tool` |
| `persona` | Compose prompts explicitly (`AgentPrompt`, instructions) |
| `hooks` | Only `HarnessConfig.hooks` (v2 five-hook set) |
| `telemetry` | Wire via your own observability around `onStreamPart` |

### Flow shape removals (Group A)

| v1 | v2 |
|----|-----|
| `Flow.hybrid` / `FlowDetourRules` | **Removed** — no off-flow detour-and-resume |
| `mode: 'strict' \| 'hybrid'` on `FlowAgent` | Strict flows only |

---

## Hooks (20 → 5)

v1 accepted `HarnessHooks` on `HarnessConfig` (20+ lifecycle hooks). v2 `HarnessConfig.hooks` uses `Hooks` only:

| v2 hook | Purpose |
|---------|---------|
| `onStart` | Turn / run opened |
| `onStreamPart` | Each `HarnessStreamPart` (replaces many stream sinks) |
| `onEnd` | Turn finished |
| `onConversationEnd` | Terminal outcome / CSAT hook surface |
| `onError` | Uncaught turn error |

### v1 hooks with no direct v2 equivalent

| v1 `HarnessHooks` | Migration note |
|-------------------|----------------|
| `onStepStart` / `onStepEnd` | Per-LLM-step — use `onStreamPart` + part types or external tracing |
| `onToolCall` / `onToolResult` / `onToolError` | Inspect tool parts in `onStreamPart` |
| `onTurnEnd` | `onEnd` |
| `onAgentStart` / `onAgentEnd` / `onHandoff` | Handoff parts in `onStreamPart` or custom wrapper around agents |
| `onMessage` | Not emitted |
| `onPersistenceError` | Handle at `sessionStore` layer |
| `onMemoryIngest` / `onMemoryIngested` | Memory ingest runs in `closeRun`; no hook |
| `onBeforeModelCall` | **No prompt override hook** — inject via instructions/tools |
| `onSessionEnd` | `onConversationEnd` (different args) |
| `onTokensUpdate` | Parse usage from stream parts if exposed |

`HarnessHooks` remains exported from `@kuralle-agents/core` for **builtin hook utilities** (`HookRunner`, `loggingHooks`, `createObservabilityHooks`) that target the legacy shape — wire them through adapters or rewrite against v2 `Hooks`.

---

## Runtime API

| v1 | v2 |
|----|-----|
| `runtime.chat(sessionId, input, userId?)` → `AsyncGenerator` | `runtime.run({ sessionId, input, userId, ... })` → `TurnHandle` |
| `runtime.stream(opts)` → `AsyncGenerator` | `runtime.stream(opts)` → `TurnHandle` (alias of `run`) |
| `runtime.runProcedure(id, input, sessionId)` | **Removed** — use flows + `ctx.tool` |
| `runtime.compressNow(sessionId)` | **Removed** |
| `runtime.drainBackgroundCompactions()` | **Removed** |
| `runtime.shutdown()` | **Removed** |
| `runtime.getAutoResolutionRate({ ... })` | **Removed** |
| `runtime.abortTurn(sessionId, reason?)` | `runtime.abortSession(sessionId, reason?)` |
| `runtime.sessionStore` (property) | `runtime.getSessionStore()` |
| `runtime.getSession` / `deleteSession` / `markOutcome` / `replayAuditLog` | Unchanged |
| `runtime.getConversationLength` | Still present |

**TurnHandle:** await the turn, iterate `for await (const part of handle)`, or use response-stream helpers on the handle. v1 `StreamOptions.channelId` is not on `RunOptions` — channel continuity from v1 `HarnessConfig.channels` is not wired in v2.

**Sessions:** v1 session blobs are not resumable. v2 persists `RunState` + durable `StepRecord[]` for effect replay.

---

## Procedures → flows + `ctx.tool`

v1 multi-step **procedures** (`defineProcedure`, `ProcedureRunner`, `buildProcedureTool`, `runtime.runProcedure`) provided checkpointed steps, per-step failure policies (`abort` / `retry` / `skip` / `escalate`), and stream events (`procedure-start`, `procedure-step-enter`, …).

All of that is **removed** (Group A). Model the workflow as:

1. A **`defineFlow()`** on the agent with `collect` / `action` / `decide` nodes for each phase.
2. **Side effects** through **`ctx.tool()`** (durable, exactly-once on resume).
3. **Human gates** through **`ctx.approve()`** where needed.
4. **External signals** through **`ctx.signal()`** for out-of-band resume.

There is no automatic step-index checkpoint or `onFailure` policy — encode retry/skip in node handlers or effect tool idempotency.

---

## JSONC packs, `@kuralle-agents/config`, and builder

v1 **packs** (`.kuralle/` folders with `kuralle.jsonc`, markdown prompts, tool folders) were loaded by **`@kuralle-agents/config`** and scaffolded by **`@kuralle-agents/builder`**.

In v2 monorepo / 2.0 release:

- **`@kuralle-agents/config`** — package **removed**
- **`@kuralle-agents/builder`** — package **removed**
- Pack agent entries with `"type": "llm" | "flow" | "triage" | "composite"` — **removed**

**Migration:** export agents as TypeScript modules using `defineAgent()`, `defineFlow()`, and `defineTool()`. Deploy with your own bundler or the remaining server packages (`@kuralle-agents/hono-server`, `@kuralle-agents/cf-agent`, templates under `apps/templates/`).

---

## Group A removals (cleanup — not coming back in v2)

Commit `cleanup A` removed v1-era code that was not wired to the v2 runtime. Do not import or expect these symbols:

| Area | Removed |
|------|---------|
| **Safety** | `HarnessConfig.safety`, `RegexPiiModerator`, `JailbreakEchoModerator`, `LlamaGuardModerator`, `createDefaultOutputModerators`, `SafetyConfig`, `OutputModerator` |
| **Escalation** | `ConfidenceRefinement`, `buildEscalateToHumanTool`, `EscalationConfig`, `EscalateToHumanToolResult` (types `EscalationReason` / `EscalationOutcome` remain where sessions need them) |
| **Compaction / facts** | `autoCompaction`, `CompactionScheduler`, `KeyFactsExtractor`, `harnessNormalize` |
| **Context / cache** | `ContextManager`, `createContextManager`, `createSummarizingContextManager`, `SessionCache`, `InjectionQueue`, `policyProfiles`, `commonInjections` |
| **Procedures** | `defineProcedure`, `ProcedureRunner`, `buildProcedureTool`, procedure types, `PROCEDURE_STATE_KEY` |
| **Callbacks** | `createHttpCallback`, `createStreamCallbackAdapter`, stream/file/console/HTTP sinks |
| **Audit** | `AuditCollector` class (`filterAuditEntries` + `replayAuditLog()` remain) |
| **Outcomes analytics** | `getAutoResolutionRate`, `AutoResolutionRateResult`, `OutcomeBreakdown` |
| **Suggestions** | `SuggestionManager` |
| **Agent config** | `escalation`, `extraction`, `persona`, `hooks`, `telemetry` on `AgentConfig` |
| **Flows** | `Flow.hybrid`, `FlowDetourRules` |
| **Pack types** | `LegacyHarnessConfig` as the harness type — `HarnessConfig` is only `runtime/Runtime.ts` |

Also removed earlier in core-v2 (see CHANGELOG): agent classes, `FlowManager`, `OrchestrationAuthority`, `RealtimeRuntime`, `CapabilityBuilder`, LiveKit native-realtime authority path.

---

## Codemod v2 scope

Script: `packages/kuralle-core/scripts/codemod-v2.ts`

```bash
# Safe: write a new file
bun packages/kuralle-core/scripts/codemod-v2.ts path/to/v1-agent.ts path/to/v1-agent.v2.ts

# In-place (keep a backup)
cp path/to/v1-agent.ts path/to/v1-agent.v1.bak
bun packages/kuralle-core/scripts/codemod-v2.ts --in-place path/to/v1-agent.ts
```

### What the codemod changes (mechanical)

| Pattern | Action |
|---------|--------|
| `type: 'llm' \| 'flow' \| 'triage' \| 'composite'` | Stripped |
| `LLMAgentConfig` / `FlowAgentConfig` / … | → `AgentConfig` |
| `prompt:` | → `instructions:` |
| `canHandoffTo` | → `handoffs` |
| `new Runtime(` | → `createRuntime(` |
| singular `flow: createFlow(...)` | → `flows: [createFlow(...)]` when detected |
| Missing imports | Prepends `defineAgent` / `createRuntime` import lines (example-relative paths) |

### What it does **not** change (prints hand-review list)

- `FlowConfig` / `transitions[]` edge tables → rewrite to v2 node kinds + returned transitions
- `expression:` / `condition:` edges → handler-returned node refs
- `createFlowTransition` → `reply.next(turn, state)` / tool-result inspection
- `HarnessConfig` field migration
- Procedures, hooks, safety, compaction, packs
- `runtime.chat` → `runtime.run` / `TurnHandle` consumption

After the codemod: run `tsc`, migrate config manually per tables above, and execute at least one live turn per agent.

---

## Other removed v1 surfaces (reference)

| v1 | v2 |
|----|-----|
| `OrchestrationAuthority` / `RealtimeRuntime` | `hostLoop` + `VoiceDriver`; provider realtime in `@kuralle-agents/realtime-audio` |
| `CapabilityBuilder` | Removed |
| Five-stage text pipeline | `openRun` → `hostLoop` → `closeRun` |
| LiveKit as realtime *authority* | Cascaded STT→LLM→TTS only via `KuralleRuntimeLLMAdapter` |

For greenfield projects, start from `packages/kuralle-core/examples/` and `apps/templates/` rather than porting pack JSONC verbatim.

---

## Tool model cleanup (`effectTools` → `tools`, 0.6.0)

**Breaking:** one durable tool field on `AgentConfig`.

| Before | After |
|--------|--------|
| `effectTools: { echo }` | `tools: { echo }` |
| `tools: buildToolSet({ echo })` + `effectTools: { echo }` | `tools: { echo }` only |
| `tools: someAiSdkToolSet` (raw `ToolSet` on agent) | `tools: { name: wrapAiSdkTool('name', t) }` per entry |

`globalTools` is unchanged (ADR-0001 always-visible safe allow-list).

Flow **nodes** still use `tools: buildToolSet({ ... })` — schema-only `ToolSet` for the model. Agent-level `tools` is the durable executor registry (`defineTool` outputs).

```ts
import { defineTool, wrapAiSdkTool } from '@kuralle-agents/core';
import { tool } from 'ai';

const echo = defineTool({ name: 'echo', description: '...', input: z.object({...}), execute: async (...) => ({...}) });

const legacy = tool({ description: '...', inputSchema: z.object({...}), execute: async (...) => ({...}) });
const agent = defineAgent({
  id: 'a',
  model,
  tools: { echo, legacy: wrapAiSdkTool('legacy', legacy) },
});
```

Codemod: replace `effectTools:` with `tools:` across agent configs; delete redundant agent-level `buildToolSet` lines.

## Derived host routing (0.7.0)

**Breaking:** the public routing-mode surface is removed. Routing behavior is derived from **(agent shape × driver output capability)**. See `docs/adr/0007-derived-host-routing.md`.

| Before | After |
|--------|--------|
| `routing: { mode: 'structured' }` (or `'tools'` / `'llm'`) | Remove `mode` — behavior is derived from `flows` / `routes` / `agents` / `instructions` |
| `routing: { default: 'support' }` | Model the fallback as a normal route with a semantic `when` (e.g. `{ agent: 'support', when: 'general support or anything else' }`) |
| `routing: { always: true }` | Removed — there is no per-turn forced selector |
| A triage agent with `instructions` + `routes` (meant to never speak) | Drop `instructions` so it derives as a **silent pure dispatcher** (routes/agents only) |

What you keep: `routing: { model }` (the control-reasoning model for the lazy guard / pure-dispatcher classifier). What you gain: `routing: { dispatch: 'strict' }` (optional no-dispatch-text override for compliance text).

```ts
// Before
const triage = defineAgent({
  id: 'triage',
  instructions: 'Route to the right specialist. Never speak to the user.',
  routing: { mode: 'structured', default: 'support' },
  routes: [{ agent: 'billing', when: 'billing' }, { agent: 'support', when: 'support' }],
});

// After — no instructions → derives as a silent pure dispatcher; fallback is a semantic route
const triage = defineAgent({
  id: 'triage',
  routes: [
    { agent: 'billing', when: 'billing or payment' },
    { agent: 'support', when: 'general support or anything else' },
  ],
  routing: { model }, // optional: cheap control model for the classifier
});
```

**Behavior change:** an answering agent (with `instructions`/`flows`/`tools`) now folds `enter_flow` / `transfer_to_agent` tools into its speaking turn — it answers or routes in one model call (no upfront per-turn selector). A routes/agents-only agent with no answering surface becomes a silent pure dispatcher. Internal: `HostControlContext.guard` removed — no consumer action unless you extended a `ChannelDriver`.
