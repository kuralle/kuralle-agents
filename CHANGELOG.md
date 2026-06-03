# Changelog

## 0.3.2 — Interactive nodes wait for the user (no auto-advance)

Patch across the package graph (`0.3.1 → 0.3.2`). Stops a flow from racing
through interactive steps on ambient context.

### Fixed (`@kuralle-agents/core`)

- **An interactive `decide` (a `withChoices` node) now waits for the user's
  reply instead of auto-deciding from stale context.** Previously, when the flow
  cascaded into a choice node *without a fresh user turn*, `runFlow` immediately
  ran `runStructured` and picked from existing context — so one rich message
  could auto-pick a product, auto-confirm an order, etc. Now such a node returns
  `stay` (parking as `awaitingUser`) after its choices are presented; it only
  decides once the user actually replies. A plain `decide` with no choices is a
  pure branch and still runs. Regression test in `test/core-flow/runFlow.test.ts`.

This complements 0.3.1 (which fixed the *resume* side). Together: interactive
flows are now strictly turn-by-turn — present choices, wait, then act — so
mutating steps (e.g. order creation) require an explicit confirmation turn.

## 0.3.1 — Multi-turn flow resume fix

Patch across the package graph (`0.3.0 → 0.3.1`). Fixes a bug that stalled any
multi-turn flow at the first interactive node when driven over a turn boundary
(e.g. a bare `runtime.run` per HTTP request, as in a web chat route).

### Fixed (`@kuralle-agents/core`)

- **`decide` nodes now consume pending user input on resume.** `runFlow`'s decide
  branch ran `driver.runStructured` over stale messages without consuming the
  buffered pending input (which `collect` already does via `awaitUser`). On
  resume the user's reply never reached `decide()`, so a paused `withChoices`
  step (cart review, order confirm, product pick) could not advance — the turn
  emitted only `done`. Decide resume now consumes pending input and appends it to
  the message history before the decision.
- **`TextDriver.runStructured` now honors `node.choices`.** It ignored the
  offered choices, so an unconstrained string schema let the model answer with
  free-form prose that `decide()` could not match. It now injects the valid
  choice ids and instructs the model to return exactly one.

Regression tests added at both seams (`test/core-flow/runFlow.test.ts`,
`test/core-channel/textdriver.test.ts`). Whole graph republished together because
internal deps pin exact versions at publish (`workspace:*` → exact), so a
core-only bump would install a duplicate `core`.

## 2.0.0 — The Conversational Harness (core-v2)

A from-first-principles rewrite of `@kuralle-agents/core`. **Breaking; no
compatibility layer.** v1 (graph-interpreter runtime, four agent types, two
flow engines, parallel voice authority) is deleted.

### Breaking changes

- **One agent primitive.** `defineAgent({...})` replaces `LLMAgentConfig` /
  `FlowAgentConfig` / `TriageAgentConfig` / `CompositeAgentConfig`. Behavior is
  derived from which fields you populate (`flows` / `routes` / `agents`), not a
  `type` discriminator. `prompt` → `instructions`; `canHandoffTo` → `handoffs`.
- **Flows are `flows: Flow[]`** of single-job nodes — `reply` / `collect` /
  `action` / `decide` — and transitions are **returned node references**, not a
  `transitions[]` edge table. The `FlowNodeConfig` god-object is gone.
- **One imperative runtime.** `createRuntime(...)` → `Runtime`; a `hostLoop` +
  `runFlow` interpret agents directly. `OrchestrationAuthority`, `RealtimeRuntime`,
  `FlowManager`, `FlowTraverser`, `ProcedureRunner`, and the 5-stage pipeline are
  removed.
- **Durable effect log.** Side effects run through `ctx.tool` / `ctx.approve` /
  `ctx.signal` and are recorded; resume replays effects for **exactly-once**
  semantics and durable human-in-the-loop pauses. Persisted session shape
  changed (`RunState` + `StepRecord[]`); v1 sessions are not resumable.
- **One channel seam.** `ChannelDriver` (`TextDriver` / `VoiceDriver`) — the same
  agent runs on text and provider-native realtime (Gemini Live / OpenAI / xAI)
  with an identical transition sequence.
- **Standard Schema** for `collect` / `decide` / `defineTool` (Zod still works).

### Removed

#### Runtime & orchestration (core-v2)

- Agent classes (`Agent`, `FlowAgent`, `TriageAgent`, `CompositeAgent`) — `defineAgent()` only.
- `FlowManager`, `FlowTraverser`, `FlowGraph`, `FlowGraphBuilder`, v1 `FlowNodeConfig` / `transitions[]` edge model.
- `OrchestrationAuthority`, `DefaultOrchestrationAuthority`, `RealtimeRuntime`, five-stage text pipeline.
- `CapabilityBuilder`; `ProcedureRunner`, `buildProcedureTool`, `runtime.runProcedure()`.
- LiveKit native-realtime *authority* path (`KuralleRealtimeAgentController`, `LiveKitRealtimeAdapter`, `ToolContextBuilder`, `TurnCompletionCoordinator`, `createVoiceSession({ mode: 'realtime' })`). LiveKit voice is cascaded-only; provider-native realtime (Gemini/OpenAI/xAI) lives in `@kuralle-agents/realtime-audio` (`VoiceEngine`).
- `Runtime.chat()`; `compressNow()`, `drainBackgroundCompactions()`, `shutdown()`, `getAutoResolutionRate()`; `abortTurn()` (use `abortSession()`); `runtime.sessionStore` getter (use `getSessionStore()`).
- v1 `HarnessHooks` on `HarnessConfig` (20+ hooks) — v2 `Hooks` has five: `onStart`, `onStreamPart`, `onEnd`, `onConversationEnd`, `onError`.
- Pack-era `LegacyHarnessConfig` and ~40 harness-only fields (`autoCompaction`, `keyFacts`, `safety`, `escalation`, `contextManager`, `sessionCache`, `streamCallback` / `callback`, `channels`, `outputRedaction`, `personaExperiment`, …); `HarnessConfig` is only `runtime/Runtime.ts` (see [`MIGRATION.md`](./MIGRATION.md)).

#### Packages & packs

- `@kuralle-agents/config` and `@kuralle-agents/builder` (JSONC `.kuralle/` packs, `loadAriaflowConfig`, `createRuntimeFromConfig`, builder CLI).
- JSONC pack agents with a `type` field — export a `defineAgent()` `AgentConfig`.

#### Group A — dead v2-unwired code (`cleanup A`)

- `Flow.hybrid` and `FlowDetourRules` (hybrid off-flow detour mode).
- Per-agent `AgentConfig` fields: `escalation`, `extraction`, `persona`, `hooks`, `telemetry`; `types/escalationPolicy.ts`, `types/extraction.ts`.
- `HarnessConfig.safety` and entire `safety/` module: `RegexPiiModerator`, `JailbreakEchoModerator`, `LlamaGuardModerator`, `createDefaultOutputModerators`, `SafetyConfig`, `OutputModerator`.
- `autoCompaction`, `harnessNormalize`, `CompactionScheduler`, `KeyFactsExtractor`, and related compaction/facts config types.
- `ConfidenceRefinement`, `buildEscalateToHumanTool`, `EscalationConfig`, `EscalateToHumanToolResult` (session types `EscalationReason` / `EscalationOutcome` remain where needed).
- `defineProcedure`, procedure types, `ProcedureTool` / `buildProcedureTool` — use `defineAgent` flows + `ctx.tool`.
- `InjectionQueue`, `createInjectionQueue`, `commonInjections`, `policyProfiles`, `getPolicyProfileInjections`.
- `ContextManager`, `createContextManager`, `createSummarizingContextManager`.
- `SessionCache`, `SuggestionManager`, `StreamEmitter`.
- `createHttpCallback`, `createStreamCallbackAdapter`, and stream sinks (`createConsoleStreamSink`, `createFileStreamSink`, `createHttpStreamSink`, `createFunctionStreamSink`).
- `AuditCollector` class (`filterAuditEntries` remains for `replayAuditLog()`).
- `AutoResolutionRateResult`, `runtime.getAutoResolutionRate()`, and `OutcomeBreakdown`.

## Unreleased — agentic-conversation program (RFC-01..RFC-09)

Ships the agentic-conversation program: three-phase pipeline,
confidence-based escalation, output safety chain, procedures,
conversation outcomes, RAG citations, multi-channel continuity,
first-class persona, and the audit log.

### Breaking changes

- **`safety.outputModerators` now defaults to
  `[RegexPiiModerator, JailbreakEchoModerator]`** (RFC-03). Previously
  no moderators ran by default. If you depend on raw, unmodified model
  output (e.g. streaming-timing or token-budget tests, low-latency
  voice paths), opt out explicitly:
  ```ts
  createRuntime({ ..., safety: { outputModerators: [] } });
  ```
  The two default moderators run in parallel under a 150 ms deadline
  per moderator. `RegexPiiModerator` redacts (`rewrite` path) — it
  never blocks. `JailbreakEchoModerator` blocks only when the user
  message matched a known injection pattern AND the model output
  echoes a sensitive pattern.

- **`KnowledgeChunk.sourceId` is now required** (RFC-06). Existing
  retrievers that don't populate `sourceId` get auto-synthesized IDs
  with a `synthetic-<sha256-prefix>` form (operators can spot
  un-migrated sources by this prefix). Migration: add a stable
  `sourceId: '<your-source-id>'` to every chunk your retriever
  returns.

- **`Session` now carries `conversationId` and `channelId`** (RFC-07).
  Backward-compat default: when no `channels.conversationStore` is
  configured, `conversationId === sessionId` (1:1) and `channelId`
  defaults to `'web'`. Existing single-channel deployments need no
  changes. To opt into multi-channel continuity, configure
  `channels.conversationStore` and pass `channelId` at the request
  edge (or let the OpenAI-compat router infer it from Vapi /
  ElevenLabs metadata).

### New default behaviors (opt-out available)

- Citation rendering defaults to `'footnotes'` when a retriever is
  configured (RFC-06). Voice / SMS channels override to `'off'` via
  their channel policy.
- `ChannelPolicy` runs AFTER the validation chain and strips
  markdown / emojis / truncates per channel (`sms` / `voice` defaults
  enabled; `web` / `email` are no-ops). Override via
  `channels.policies`.

### Opt-in features (default off)

- `escalation` — confidence-based escalation + `escalate_to_human`
  auto-tool (RFC-02). Off until `escalation.enabled: true`.
- `audit` — per-event audit log subscriber + Hono `GET
  /api/sessions/:id/audit` endpoint (RFC-09). Off until
  `audit.enabled: true`.
- `outcomes.autoAbandonAfterMs` — background sweeper that marks
  inactive sessions `'abandoned'` (RFC-05). Off unless explicitly
  configured.
- `personaExperiment` — 2-arm A/B test over `BuiltinPersonas`
  (RFC-08). Off unless configured; cohort is pinned to the session
  via `metadata.personaExperiment`.

### Bug fixes / hygiene

- `markOutcome` for terminal outcomes (`resolved` / `escalated` /
  `abandoned`) now calls `conversationStore.closeConversation()` when
  configured, so the user's next message starts a fresh conversation
  instead of re-entering the closed thread within `windowMs`.
- `@kuralle-agents/postgres-store` gains a `prebuild` clean step that
  removes stale compiled test artifacts from `dist/`.
