# Changelog

## 0.8.5 — Agentic harness completion (escalation, wake, memory lifecycle, guardrails, commerce, simulation)

Unified bump across the graph (published 0.7.2 → 0.8.5; the 0.8.0 changes below ship in this same release). **Not breaking** — every surface is additive. Closes the six gaps from the industry-baseline evaluation; most wire dormant seams the v2 recon flagged as "shipped but silent". See `docs/adr/0010-agentic-harness-completion.md`, `docs/adr/0011-commerce-package.md`, and `MIGRATION.md`.

**Escalation/handoff loop** (`@kuralle-agents/core` + `@kuralle-agents/engagement`):
- `HarnessConfig.escalation { handler, summarize?, model?, recentMessageCount? }` — every escalation path (validator `escalate`, host control, terminal handoff, flow `escalate()`) builds an `EscalationRequest` (state snapshot + recent messages + optional LLM handoff brief) and invokes the handler; outcome recorded on `session.metadata.lastEscalation` and emitted as an `escalation` stream part. Flow escalations notify at the `__escalate` pause; a one-shot latch prevents double-fire after resume.
- `runtime.resumeFromEscalation(sessionId, { resolutionSummary? })` — appends the human's resolution as context, clears parked flow/signal state, resumes the bot.
- Engagement bridge: `createOwnershipEscalationHandler({ ownership, notify? })` claims thread ownership (bot sends suppressed by `ownershipGate`); `resolveEscalation` releases + resumes.

**Proactive turns + one scheduler contract**:
- `RunOptions.wake { reason, payload? }` — agent-initiated turns (cart abandonment, follow-ups): a system wake note enters history, free-conversation agents re-engage, active flows re-prompt their current step; `wake` stream part emitted.
- `Scheduler`/`ScheduledJob` contract moved to core (engagement re-exports; `SendJob` = alias). `createWakeJobRunner(runtime, { deliver })` runs wake jobs and hands the produced parts to the host's delivery (e.g. the window-safe outbound pipeline). `createScheduleFollowupTool(scheduler)` lets the agent schedule its own follow-ups.
- **Cloudflare DO-alarm backend**: `KuralleAgent.wakeScheduler()` / `scheduleWake()` ride the agents SDK's durable scheduling; wake turns persist + broadcast through CF's machinery. Workerd parity test included.

**Memory lifecycle**:
- `HarnessConfig.compaction { model?, triggerTokens?, keepRecentMessages?, summaryPrompt? }` — post-turn history summarization (off the latency path); kept tail always starts at a user message. Emits `context-compacted` / `compaction-skipped`.
- Context-overflow recovery wired (the classifier shipped since v2 with zero callers): on a provider overflow the runtime strips the failed turn's partials, force-compacts once, retries once; emits `context-overflow-recovered`.
- `createFactMemoryService({ store, model })` — LLM fact extraction with merge-on-ingest (existing facts + transcript → complete updated list), per-user block on any `PersistentMemoryStore` (file / Postgres / Redis / CF DO SQLite), injection-scanned writes. Identity verified end-to-end: messaging `customerId` → `RunOptions.userId` → memory owner.

**Real guardrails** (the pipeline existed; the guards now ship):
- `createPromptInjectionGuard()` (audited pattern set shared with memory-write scanning), `createPiiInputGuard()`/`createPiiOutputGuard()` (Luhn-validated cards + emails by default, opt-in phone/IBAN, redact-or-block), `createModerationGuard()`/`createModerationOutputGuard()` (temperature-0 LLM classifier, fail-open default), `createGroundingValidator()` (the productized Kapruka H6 gate: completed-action claims vs tool calls/state/citations, rewrite-not-block).
- Pre-turn blocks now emit `safety-blocked { moderator, rationale, userFacingMessage }`.

**Commerce**:
- New `@kuralle-agents/commerce`: integer minor-unit `Money`, `ProductCatalog` contract, durable cart tools in flow state (`product_search`/`cart_add`/`cart_remove`/`cart_view`), idempotent `createOrderTool` (content-key ledger + in-flight coalescing — the Kapruka pattern, productized), `toWhatsAppProductList` mapper.
- `@kuralle-agents/messaging-meta` WhatsApp commerce surface: `sendProduct`, `sendProductList` (limits validated), `sendCatalog`, `sendAddressRequest`; inbound `order` webhooks normalized with typed `parseInboundOrder` / `parseInboundAddress`. Payment messages deliberately out of scope.

**Simulated-user eval + LLM judge** (`@kuralle-agents/core`):
- `simulateConversation({ runtime, persona, userModel })` — an LLM persona (profile/goal/temperament) drives a real runtime to goal-met/give-up/max-turns; `createJudge({ model, dimensions? })` scores transcripts 1–5 on goal completion, grounding, tone, efficiency; `runSimulationSuite` is the CI gate (gave-up always fails).

**New exports** also include: `ToolContext`, `ActionContext`, `AnyTool`, `compactMessages`, `isContextOverflowError`, `buildEscalationRequest`, `ensureSessionMetadata`.

## 0.8.0 — Multimodal intake + Cloudflare durable HITL (BREAKING)

Unified minor bump across the graph (0.7.2 → 0.8.0). **Breaking type change**: the runtime accepts multimodal user input instead of only `string`. See `docs/adr/0009-multimodal-intake.md`.

**Cloudflare (`@kuralle-agents/cf-agent`):**
- **Upgraded to `agents@^0.15` + `@cloudflare/ai-chat@^0.8.4`** (was `agents@0.11.5` + `ai-chat@0.1.x`, a peer mismatch that crashed the chat path with `this.mcp.ensureJsonSchema is not a function`). `KuralleAgent` needed no API changes.
- **Multimodal on CF** — `KuralleAgent.getLastUserInput` now maps CF UIMessage file parts to `UserInputContent` (was text-only), so prescription images / uploads reach the model. Exposed as `lastUserInputFromMessages`.
- **Durable human-in-the-loop on CF** — new `KuralleAgent.resumeWithSignal(signal)` + a `POST …/resume` route deliver a durable signal to a suspended run, then persist + broadcast the resumed assistant turn. This is the "payment link → resume the conversation" primitive.
- **Fix: durable runs now persist on CF** — `BridgeSessionStore` round-trips the Kuralle run journal (`durableRuns`) through `OrchestrationStore`; without it, durable tools and suspend/resume failed with "Run not found".
- **Fix (core): `RunContext.resetCallsites()` at flow entry** — anchors a flow's durable effect callsites to the flow itself, so a run entered via `enter_flow` (after an answering turn) resumes correctly instead of re-suspending on a callsite mismatch.
- New exports: core — `SignalDelivery`, `SessionDurableRuns`, `PersistedRun`, `DURABLE_RUNS_KEY`. Verified end-to-end on a live Workers+DO deploy (`apps/playground/pharmacy-rx-agent`): multimodal intake, multi-tenant DO isolation, persistent cart, and payment-link → resume → order-complete.

**Why:** the runtime accepted only text — `RunOptions.input` was `string`, and every ingress collapsed rich input to text *before* it reached the runtime (web `extractInputFromBody` filtered UIMessage parts to text-only; messaging `resolveInbound` returned `m.text ?? ''` and never read `m.media`). A photo, document, or WhatsApp voice note arrived as an empty string. This blocks every vertical whose first input is an image or voice note.

**Breaking:**
- `RunOptions.input: string` → **`UserInputContent`** (= the AI SDK `UserContent`: `string | Array<TextPart | ImagePart | FilePart>`). A plain string is still valid, so text-only callers compile unchanged — but anyone who *declared* `input: string` must widen it.
- `ChannelPolicy.resolveInbound(m)` and `@kuralle-agents/messaging`'s `InboundResolverPlugin` now return `{ input: UserInputContent; selection? }`. Custom resolver/policy implementations must widen their return type.

**What's new:**
- **Multimodal threads straight to the model.** `openRun` builds `{ role: 'user', content }` from `UserInputContent` with no translation — Kuralle is AI-SDK-native (ADR 0005), so we adopt the AI SDK's own content type rather than inventing a media type.
- **Web ingress** (`createKuralleChatRouter`): UIMessage `parts` → content — text → `TextPart`, `{type:'file', url, mediaType}` → `FilePart{ data: url }` (the ai-chatbot upload shape). Text-only input collapses back to a plain string (byte-identical text flows).
- **Messaging ingress**: `createMessagingRouter` runs the new `attachInboundMedia(message, input, platform)` after the resolver chain — it downloads inbound media via `platform.downloadMedia(id)` (or passes a hosted `url` through), base64-encodes it, and attaches a `FilePart` + caption `TextPart`. Channel-agnostic; works with or without the engagement policy layer.
- **Voice notes**: `HarnessConfig.transcriptionModel?: TranscriptionModel` (AI SDK). When set, inbound audio parts are transcribed to text before the turn (so voice works on text-only models); when unset, audio passes through to audio-capable models (e.g. Gemini). `data:`/`http(s)` audio sources are normalized for `transcribe`.
- **New exports** — `@kuralle-agents/core`: `UserInputContent`, `userInputToText`, `hasMediaParts`, `transcribeAudioParts`. `@kuralle-agents/messaging`: `attachInboundMedia`.

**Durability invariant:** `FilePart.data` flowing through the runtime must be JSON-serializable (base64 string / data URL / https URL), never a raw `Buffer` — `RunState.messages`, `session.messages`, and the pending-input buffer are all persisted through the `SessionStore`.

**Not multimodal:** the legacy `/api/flow/*` string-only endpoints (`flowManager.process(input: string)`) degrade media to its text projection — a capability limit of that older subsystem, not the runtime path.

See `MIGRATION.md` and `docs/adr/0009-multimodal-intake.md`.

## 0.7.2 — Wire provider prompt caching (was shipped-but-dead)

Unified patch bump across the graph (0.7.1 → 0.7.2). `runtime/promptCache.ts` shipped full provider-prompt-cache support since 0.6.x but had **zero callers** and was **not exported** — every speaking-turn `streamText` ran with no `providerOptions`, so OpenAI `promptCacheKey` was never set and Anthropic `cache_control` was never applied. Found by the syrinx team's loop-back; verified (zero callers, not exported, no `providerOptions` on `TextDriver:77` / `extractionTurn:39`).

**What's new:**
- **Prompt caching is now wired and default-on**, gated by conservative provider detectors. New single owner `applyPromptCache(model, sessionId, messages)` is called from both `streamText` sites (`TextDriver`, `extractionTurn`):
  - **Anthropic** → `cache_control` breakpoints (caches the `system + tools` prefix + recent history; ~up to 75% input-cost + a TTFT chunk off every multi-turn turn — Anthropic caching is opt-in, so this was 0% before).
  - **OpenAI Responses** → `promptCacheKey = sessionId` (pins same-session turns to one cache slot) + `truncation: 'auto'` overflow safety net.
  - Other providers → untouched (no-op).
- The helpers (`applyPromptCache`, `applyAnthropicCacheControl`, `buildOpenAIResponsesProviderOptions`, `isAnthropicLanguageModel`, `isOpenAIResponsesModel`) are now **exported from `@kuralle-agents/core`** so custom drivers can opt in.

Prompt assembly was already cache-friendly (static instructions first, volatile RAG/memory appended last), so this is a pure wiring fix. No API change, not breaking. Note: the separate Layer-2 *retrieval* cache is still unwired (see ADR 0008) — a distinct follow-up.

**Validated live** (`packages/kuralle-e2e-tests/prompt-cache-validation.md`):
- **OpenAI** — cache HIT confirmed through the shipped helper: turn 1 `cacheReadTokens=0`, turns 2–4 `=10240` (~99% of the prompt cached → ~half the input cost on repeat turns).
- **Anthropic** — wired + unit-tested; not live-validated (no key in env).
- **Gemini** — kuralle wires nothing (implicit caching is parameter-free), but implicit caching is best-effort and **did not fire** in a 4-turn live probe; *guaranteed* Gemini caching needs explicit `CachedContent`, which is **not** wired (open follow-up).
- **Cloudflare AI Gateway** — the provider prompt cache rides through the gateway (request-body fields are forwarded); the gateway's own response cache is a separate, byte-identical, off-by-default layer.

## 0.7.1 — On-demand retrieval (declared grounding contract)

Unified patch bump across the graph (0.7.0 → 0.7.1). No API removed, no type change, not breaking; the existing `knowledge.autoRetrieve` boolean now declares **who invokes retrieval** — the runtime or the model. See `docs/adr/0008-declared-grounding-contract.md`.

**What's new:**
- **`knowledge.autoRetrieve: false` now means on-demand, not off.** Previously `false` left knowledge inert (declared, nothing wired). It now skips pre-injection **and** wires a core `knowledge_search` global tool, so the model retrieves only when it answers — routing/dispatch turns pay **zero** retrieval tax (grounding becomes model-discretion). `true` (default) is unchanged: pre-inject before every answering turn.
- The pre-injection provider and the `knowledge_search` tool are mutually exclusive, selected by the existing boolean — no new mode field, no behavior fork to configure.

**Behavior change (non-breaking, no type change):**
- Agents that set `knowledge.autoRetrieve: false` previously got no retrieval at all; they now expose `knowledge_search` to the model. Drop `knowledge` entirely to disable retrieval.
- **Unchanged:** `knowledge.autoRetrieve: true`/omitted (guaranteed pre-injection); node-level `grounding.knowledge.autoRetrieve: false` (per-node opt-out).

See `MIGRATION.md` and `docs/adr/0008-declared-grounding-contract.md`.

## 0.7.0 — Derived host routing (BREAKING)

Unified minor bump across the graph (0.6.1 → 0.7.0). **Breaking**: removes the public routing-mode surface. Routing behavior is now derived from **(agent shape × driver output capability)** — see `docs/adr/0007-derived-host-routing.md`.

**Removed (breaking):**
- `routing.mode`, `routing.always`, `routing.default` from `RoutingPolicy` — there is no routing-mode enum.
- Lexical/deterministic routing (`deterministicRouteMatch`, `keywordRouteFallback`) on the hot path — routing is **model-reasoned only** (multilingual-safe).
- Stale `Flow.hybrid` / "hybrid mode" doc references (the feature was removed in the v2 reset).

**What's new:**
- **Derived routing** — answering agents (`instructions`/`flows`/`tools`/…) fold `enter_flow` + `transfer_to_agent` control tools into the speaking turn; routes/agents-only agents with no answering surface become **silent pure dispatchers**. A keep turn pays **zero** routing cost (the per-turn `generateObject` selector is gone — keep-turn TTFT ~2.9s → ~0.9s in the A/B smoke).
- **Lazy host-control guard** — a forgot-to-route net that classifies **only** when an answering turn ends with no control tool and no substantive text. Answered + main-control turns make zero classifier calls; the guard has a single owner (the host loop) and is evaluated at most once per turn. Emits `host-guard` telemetry.
- **`routing.dispatch?: 'strict'`** — optional compliance override (no user-facing dispatch text) for controlled-TTS / text channels. Strictness otherwise derives from the driver's output capability (native-realtime stays advisory, consistent with ADR-0004).
- **`routing.model`** — still selects the control-reasoning model for the guard / pure-dispatcher classifier.

**Migration:**
- Remove `routing.mode` (`'tools'`/`'structured'`/`'llm'`), `routing.always`, `routing.default` — populate `flows`/`routes`/`agents`/`instructions` and the runtime derives behavior. Model a fallback as a normal semantic route/child agent, not `routing.default`.
- A routes-only triage agent now derives as a **silent pure dispatcher** (no fallback prose) — add `instructions` if it must speak before routing.
- Internal: `HostControlContext.guard` removed (drivers no longer own the guard). No consumer action unless you extended a `ChannelDriver`.

See `MIGRATION.md` and `docs/adr/0007-derived-host-routing.md`.

## 0.6.1 — zod 4

Unified patch bump across the graph (0.6.0 → 0.6.1). Migrates the framework from **zod 3 to zod 4**.

- All packages now depend on (and peer) **`zod@^4`**. Consumers should be on zod 4.
- Internals migrated off the zod-3-only `zod-to-json-schema` to zod 4's native `z.toJSONSchema`; `z.record` calls updated to the 2-arg form; tool-type inference fixes.
- `wrapAiSdkTool()` now accepts any structurally-compatible AI SDK tool (decoupled from a specific `ai` instance/version).
- Resolves the `@kuralle-agents/cf-agent` npm `ERESOLVE` (the `agents` SDK peers `zod@^4`; the dependency graph now matches).

No API changes beyond the zod peer bump. Verified: full build + `typecheck:all` + test suite green.

## 0.6.0 — Filesystem, Skills, Working memory (BREAKING: `AgentConfig.tools`)

Unified minor bump across the graph (0.5.0 → 0.6.0). One breaking change (the tool-model rename below); the rest is additive. New packages: **`@kuralle-agents/fs`**, **`@kuralle-agents/skills`**.

**Breaking:** `AgentConfig.effectTools` is renamed to `AgentConfig.tools` (durable `Record<string, AnyTool>`). The old raw `tools?: ToolSet` field on `AgentConfig` is **removed** — third-party AI SDK tools must use `wrapAiSdkTool()`.

**Migration:**
- `effectTools: { myTool }` → `tools: { myTool }`
- Remove paired `tools: buildToolSet({ ... })` on the agent when it duplicated executors — flow nodes still use `buildToolSet` for model-visible schema.
- Raw AI SDK `tool({ execute })` on the agent → `tools: { name: wrapAiSdkTool('name', aiTool) }`

**What's new:**
- **`wrapAiSdkTool(name, aiTool)`** — adapts AI SDK tools for journaled execution through `CoreToolExecutor`.
- **`scripts/check-no-raw-tool-execute.sh`** — CI guard wired into `typecheck:all`; fails if raw `execute` could reach `streamText`.
- Host-reply (off-flow) tools route through the durable journal via `buildToolSet` + registered executors.

**Filesystem (`@kuralle-agents/fs`, new):** portable `FileSystem` interface + `InMemoryFs` (zero `node:*`, Node + Workers); one durable `workspace` tool (`ls/cat/grep/find/read/write/edit`); `AgentConfig.workspace` (read-only by default). `CompositeFileSystem` routes by path prefix (mount `/kb`, `/docs`, `/scratch`…). `KnowledgeFs` (in `@kuralle-agents/rag`) exposes a vector store as a read-only filesystem (`cat` = chunk reassembly, optional BM25 grep, RBAC tree-prune).

**Skills (`@kuralle-agents/skills`, new):** Anthropic-style Agent Skills — `SKILL.md` + 3-level progressive disclosure via a `SkillsCapability`; `AgentConfig.skills`; scripts are allow-listed durable tools.

**Working memory:** `AgentConfig.memory.workingMemory` — durable USER/MEMORY blocks loaded into the prompt + maintained by the model via the auto-registered `memory_block` tool (Mastra-style directive injected automatically). Stores: `InMemory`, `File` (`~/.kuralle/memories`), `Postgres`, `Redis`/Upstash, and CF-native `SqlPersistentMemoryStore` (DO SQLite). Composite: `RoutedPersistentMemoryStore` (by scope) + `TieredPersistentMemoryStore` (read-through cache). See the new **Memory** guide.

**Cloudflare:** every new primitive ships day-1 Workers support (`workerd` parity tests; cf-agent auto-wires DO-SQLite working memory, zero config).

See `MIGRATION.md` (Tool model cleanup section), `docs/adr/0006-fs-reframe-and-working-memory.md`, and `rfcs/kuralle-harness/`.

## 0.5.0 — AI-SDK-native by default (BREAKING: web stream output)

Unified minor bump across the graph (0.4.1 → 0.5.0). **Breaking wire-format change for web consumers of `POST /api/chat/sse`** — no compatibility shim on the default path.

**Breaking:** the default web/HTTP streaming response is now an AI SDK `UIMessageStream` (`useChat` works with **no bridge**). Raw `HarnessStreamPart` JSON-SSE moved to opt-in: append `?format=raw` to `/api/chat/sse` (and `/api/flow/sse`). `createKuralleSseChatRouter` remains the explicit raw-SSE-only router.

**Consumer migration:**
- **Web/React:** delete any hand-rolled `HarnessStreamPart` → `UIMessageChunk` bridge; point `useChat` at `POST /api/chat/sse` (default). Read Kuralle orchestration events from `message.parts` (persistent `data-kuralle-*`) or `useChat({ onData })` (transient telemetry).
- **Raw JSON-SSE consumers** (curl, Studio, custom transports): append `?format=raw` to preserve the 0.4.x wire.

**What's new:**
- **`harnessToUIMessageStream()`** — pure adapter from `HarnessStreamPart` to AI SDK `UIMessageStream`; native text/tool parts + typed `data-kuralle-*` for Kuralle orchestration residue.
- **`TurnHandle.toUIMessageStreamResponse()`** — convenience returning `createUIMessageStreamResponse`.
- **`KuralleUIMessage` / `KuralleDataParts`** — typed `UIMessage` for compile-time-safe `message.parts` and `onData`.
- **`createKuralleChatRouter`** — `POST /api/chat/sse` defaults to native `UIMessageStream`; accepts `useChat`-shaped `{ messages: UIMessage[] }` inbound.

**Unchanged:** `HarnessStreamPart`, `toResponseStream('sse'|'ndjson')`, cascaded voice, messaging, WebSocket widget (still `HarnessStreamPart` JSON).

See `docs/adr/0005-ai-sdk-native-uimessage-default.md` and `docs/rfc-ai-sdk-native-uimessage-stream.md`.

## 0.4.1 — Streaming follow-up fixes (patch)

Patch across the graph (0.4.0 -> 0.4.1). Backward-compatible fixes to the 0.4.0 streaming release; no API changes.

- **Fix (behavioral):** off-script answers in the collect **digression** path were emitted **twice** — `runFlow`'s `collectDigression` re-emitted the assistant-text lifecycle on top of the one `ChannelDriver.runAgentTurn` already produces. The driver is now the single owner of the assistant-text lifecycle; the digression path only appends the answer to history. (Regression test added asserting a single answer emit + single re-ask.)
- **Docs (shipped):** the published `@kuralle-agents/core` `guides/` (GETTING_STARTED / TOOLS / FLOWS / AGENTS) still showed `part.text` in streaming snippets — migrated to `part.delta` for the 0.4.0 lifecycle. Added `scripts/check-no-stale-text-delta.sh` to fail CI on stale `text-delta.text` reads/constructors in publishable files.
- **Internal:** cleared pre-existing `typecheck:all` drift in test/example tsconfigs and the playground (`'a'`→`Transition`, optional-`decide` narrowing, dual hook-vs-wire `RunContext` in a test, `part.text`→`part.delta` in playground CLIs); the full `typecheck:all` gate (incl. playground + lint) is green again. No shipped-API change.

## 0.4.0 — Streaming-by-default (BREAKING: assistant-text event lifecycle)

Unified minor bump across the graph (0.3.20 -> 0.4.0). **Breaking event-protocol change — no compatibility shim.**

**Breaking:** the single-shot `{ type: 'text-delta'; text: string }` is **removed** and replaced with a four-variant assistant-text lifecycle on `HarnessStreamPart` (`types/stream.ts`), the voice union (`types/voice.ts`), and `AgentStreamPart` (`types/processors.ts`):

```
| { type: 'text-start'; id: string }
| { type: 'text-delta'; id: string; delta: string }   // was { text: string }
| { type: 'text-end'; id: string }
| { type: 'text-cancel'; id: string; reason: string }
```

**Consumer migration:** read `part.delta` (not `part.text`); handle (or ignore) `text-start`/`text-end`/`text-cancel`. Mirrors AI SDK v6 `UIMessageChunk`.

**What's new:**
- **Streaming-by-default.** Replies stream incrementally up to the smallest guardrail boundary each attached gate permits — `token` (no gate), `sentence` (per-utterance gate), `turn` (whole-answer grounding gate). An ungated reply now emits multiple `text-delta`s with the first before turn-end (was: one buffered delta at turn-end).
- **Shared `speakGated` emission path** for text + native-realtime voice; `SentenceAggregator` + `resolveStreamMode` + a `streamGranularity?: 'sentence'|'turn'` field on output processors / validation policies (default `turn`, safe).
- **Cascaded LiveKit TTFT** drops to first-token latency (`aria_runtime_ttft` fires on the first delta).
- **Native realtime gate is advisory (REQ-9):** the provider speaks audio before any gate runs, so a whole-answer gate on native realtime emits a `safety-*` event + correction post-hoc but cannot un-speak audio. Preventive only on text/cascaded. See ADR 0004.

See `docs/adr/0004-streaming-by-default.md` and `docs/rfc-streaming-by-default.md`. Downstream consumers (e.g. external Studio `SSEChatTransport`) migrate `part.text` -> `part.delta`.

> Known (non-shipping): `bun run typecheck:all` reports pre-existing drift in 4 test/example tsconfigs (unrelated to streaming; not in published tarballs, which build from `src`). Tracked as a follow-up; the published packages build clean.

## 0.3.20 — ValidateInput.state (grounding validators can see flow state)

Patch across the graph (0.3.19 -> 0.3.20). `ValidateInput` now carries `state` (the
flow `runState.state`), passed by `applyPostTurnPolicies`. A grounding `ValidationCapability`
can now ground a claim against evidence an ACTION node wrote (e.g. `state.orderRef`
after a create-order tool) — which `toolCallsMade` (this turn`s model tool calls
only) does NOT capture. Without this, a validator that grounds order/delivery
claims on `toolCallsMade` false-positives on the reply turn that follows an action
node (the tool ran in the prior node). Additive: existing validators ignore the
new field. core 485/485.

## 0.3.19 — Export pending-input buffer helpers (custom ChannelDriver support)

Patch across the graph (0.3.18 -> 0.3.19). `setPendingUserInput`/`consumePendingUserInput`/`peekPendingUserInput`/`hasPendingUserInput` are now exported from `@kuralle-agents/core/runtime`. A custom `ChannelDriver` (or a test fake) needs `consumePendingUserInput` to implement `awaitUser` the same FIFO-aware way the built-in drivers do — since 0.3.13 (H3) the buffer is an ordered queue, so hand-reading the workingMemory key as a string silently breaks. No behavior change; export-only.

## 0.3.18 — H6: author-reachable confidence/grounding gate

Patch across the graph (0.3.17 -> 0.3.18). Completes the text-hardening backlog.
The `ValidationCapability` machinery existed but was unreachable (`resolvePolicies`
hardcoded `validationPolicies:[]`, `agentTurn` hardcoded `knowledgeCitations:[]`),
and a `block` decision emitted a fallback then continued as if the turn happened —
no engine backstop against a hallucination. H6 (additive-by-config, NO flag):
- `AgentConfig.validate` / `refine` are wired through `resolveAgentPolicies`.
- Retrieved `SourceRef[]` citations from gather are threaded into `ValidateInput`
  (the missing half of W3 grounding) + a `knowledge-citation` audit entry.
- A `block` / `escalate` validation decision now emits a SAFE message (never the
  un-validated model draft) and reroutes via the existing W1 recover/escalate
  control path — instead of streaming the reply and continuing.
- New `ReplyNode.confidenceGate { min, onLow }`: a low-confidence turn routes to
  `onLow` + a low-confidence escalation audit entry. `TurnResult.confidence`
  populated from the validation decision.
Additive: an agent with no `validate`/`refine`/`confidenceGate` is byte-identical
to 0.3.17 (parity test — empty policy list short-circuits to the model text).
core 485/485; W1/W9/H1/H4/H5/confirm-gate/parking/turn-lock green.

## 0.3.17 — H5: in-flow digression / answer-then-resume (default OFF)

Patch across the graph (0.3.16 -> 0.3.17). Behind the same default-OFF flag as H1
(`agent.experimental.outOfBandControl`). Today once a flow is active, host routing
never re-runs and an off-script question at a `collect` node is discarded (field
stays unfilled → re-ask). When ON: if a turn's input at a collect does NOT advance
it, a digression step runs — (a) `selectHostTarget` (excluding the active flow) can
route/handoff or **switch to another flow** with the current flow **parked** at its
node (`__flowPark`; resumed when the switched flow ends), or (b) the off-script
question is answered by one free-conversation turn and the collect re-asks (flow
resumes next turn). On-topic input still collects; multi-intent split deferred.
New `src/flow/collectDigression.ts`; `normalizeTransition` gains a `switchFlow`
variant (type-only; produced only by digression). Flag OFF: collect loop
byte-identical (parity test). core 478/478; W1/W9/H1/H4/confirm-gate/parking/
turn-lock green.

## 0.3.16 — H4: constrained-enum decide + code-first routing

Patch across the graph (0.3.15 -> 0.3.16). Generalizes W9's deterministic pattern
to all `withChoices` `decide` nodes. (1) Choice-decides now build the
`generateObject` schema from the node's actual choice ids as a closed `z.enum`
(+ a reserved `__none` member so the model can decline rather than be forced into
a wrong branch) — an invalid branch is structurally impossible, replacing the old
soft prompt-instruction. (2) `matchChoiceFromInput` resolves a clear input (exact
id/label or unambiguous keyword) in code and SKIPS the LLM entirely; the pinned
temp-0 control model (H2) only arbitrates genuine ambiguity. (3) `select.ts` host
routing tries a deterministic route/keyword match BEFORE `generateObject` (was
LLM-first with a post-hoc fallback). Conservative guard: the enum + code-first
apply only when the node has `choices` and the schema is exactly
`z.object({ choice: z.string() })`; other shapes keep legacy behavior. confirmGate
and choice-less decides untouched. New `src/flow/choiceMatch.ts`. core 471/471;
W1/W9/H1/confirm-gate/parking/turn-lock green.

## 0.3.15 — H7a: interim filler + per-tool timeout + extraction telemetry

Patch across the graph (0.3.14 -> 0.3.15). First half of H7 (tool execution
hardening). (1) The previously-dead `onInterim` callback is wired in `Runtime` to
emit a `text-delta` filler, so a slow tool with `interim`/`interimAfterMs` speaks
instead of going silent. (2) New per-tool `Tool.timeoutMs`: `CoreToolExecutor`
races execution against a `ToolTimeoutError`, which flows through
`executeModelToolCall` → `toolErrorResult` → the W1 recovery boundary — closing
the "hung tool throws nothing, so W1 never fires" hole (every peer agent engine
has a timeout/duration guard). Timer is cleared on abort/success/error and
`unref`'d; unset `timeoutMs` = no change. (3) The modeled-but-never-emitted
extraction telemetry (`flow.extraction.submission` with fieldsAccepted/Rejected,
`flow.extraction.update`) is now emitted from the collect path and fed to the
observability hook. (4) Legacy `tools/Tool.ts` `filler`/`estimatedDurationMs`
converge onto the canonical `interim`/`interimAfterMs` (deprecated aliases kept).
Execution modes (immediate/post_speech/async) are H7b. core 458/458;
W1/W9/H1/parking/turn-lock green.

## 0.3.14 — H1: out-of-band control evaluator for flow reply nodes (default OFF)

Patch across the graph (0.3.13 -> 0.3.14). The W2 keystone, scoped to flow reply
nodes (ADR 0003 Revision 1, kimi-k2.6-reviewed). Behind a default-OFF flag
`agent.experimental.outOfBandControl`. When ON: a flow reply node's model-visible
tool dict EXCLUDES flow-transition control tools (handoff/transfer_to_agent/final/
escalate/recover — still registered in the executor, just not offered to the
speaker), and a deterministic `evaluateReplyControl` decides the transition from
structured signals — `interrupted` → redispatch, a data-tool/W1 control-result
shape → transition, else `node.next` → transition. So flow routing is decided by
the flow, not by the model picking a control tool mid-generation. NO new LLM calls
(purely deterministic). Free conversation (`hostLoop.runFreeConversation`, marked
`ResolvedNode.freeConversation`) is untouched — it keeps its model control channel.
Flag OFF reproduces 0.3.13 byte-for-byte (the original dispatch branch is preserved
verbatim; parity test). Pre-emission reask + the semantic classifier are deferred
to H6. core 449/449; W1/W9/parking/turn-lock green.

## 0.3.13 — H3: per-session turn lock + FIFO input inbox

Patch across the graph (0.3.12 -> 0.3.13). Second hardening chunk
(`docs/kuralle-hardening-plan.md`, Phase 0). Closes the overlapping-turn race:
two concurrent `runtime.run()` on the SAME session (double-tap, retry-on-slow-
stream, multi-tab, reconnect) used to interleave — both buffered into one
overwritable input slot (last-writer-wins ate a message) and an empty consume
threw. Now `Runtime.run` serializes turns per session via the (previously
unwired) `SessionMutex` — the second turn's body, including its `openRun` buffer
write, does not start until the first finishes; different sessions stay
concurrent. The input buffer is an ordered FIFO (`setPendingUserInput` enqueues,
`consumePendingUserInput` dequeues oldest and returns '' instead of throwing;
legacy string slots coerce to a single-item queue). `turnInputConsumed` and all
interactive-node parking are unchanged. core 438/438, engagement 107/107,
hono 52/52; W1/W9/collect-parking suites green.

## 0.3.12 — H2: pinned temperature-0 control-model channel

Patch across the graph (0.3.11 -> 0.3.12). First chunk of the core-primitive
hardening plan (`docs/kuralle-hardening-plan.md`), the cheapest highest-leverage
anti-flakiness lever. The control path (routing, `decide`/`runStructured`, collect
extraction) ran on the same model that speaks to the user, at default sampling —
so identical prompts produced different routes/branches/extractions across
providers and runs (the gpt-4.1-mini-vs-gemini-3.1-flash-lite reliability gap).
New optional `AgentConfig.controlModel` (resolved onto `RunContext.controlModel`,
defaulting to the speaker model) pins every control-path LLM call to a single
model at `temperature: 0`. The speaker path (`runAgentTurn`) is unchanged. Set
`controlModel` to pin control to a reliable provider independent of the speaker.
core 430/430, engagement 107/107, hono 52/52.

## 0.3.11 — Voice paused: text is the primary channel

Patch across the graph (0.3.10 -> 0.3.11). Kuralle now hardens **text as the
primary primitive**; provider-native realtime voice is **paused**. The realtime
`VoiceDriver` is removed from the package's headline API (`@kuralle-agents/core`
no longer exports it) — it remains intact behind the `@kuralle-agents/core/runtime`
subpath for `@kuralle-agents/realtime-audio`, which is unchanged. No realtime model
code was deleted. `@kuralle-agents/livekit-plugin` (cascaded STT → Kuralle text
runtime → TTS) is unaffected — it runs on `runtime.run` (the default TextDriver),
not the realtime VoiceDriver.

Also fixed a VoiceDriver/TextDriver parity escape hatch: `VoiceDriver.runStructured`
now applies the same single-choice-id constraint TextDriver already had, so a
`decide` node behaves identically on both channels. READMEs note the pause + point
to cascaded voice. core 422/422, engagement 107/107, hono 52/52.

## 0.3.10 — W3 per-node context scoping

Patch across the graph (0.3.9 -> 0.3.10). Third chunk of the conversational-stability
program (ADR 0002). Grounding was assembled once per turn, agent-wide, for reply
nodes only — every node retrieved with the same KB scope and the same query
(`latestUserMessage`), even when the node's job had nothing to do with the user's
last words. W3 makes grounding node-scoped on reply nodes (the ElevenLabs per-node
context-assembly model; `decide` stays a KB-free out-of-band evaluator, `collect`
extraction stays silent). New optional `ReplyNode.grounding` (`NodeGrounding`): a
node-specific `query` (string or `(state, history) => string`), a node `knowledge`
subset merged over the agent's (`filter`/`topK`/`maxOutputTokens`/`autoRetrieve:false`),
and node `memory` (`preload:false`/`tokenBudget`). `runGatherPhase(ctx, scope?)` is
now node-aware; `AutoRetrieveProvider.retrieve`/`MemoryService.preload` take an
optional `GatherScope`. No provider changes — the per-call query+overrides path
already existed. Additive: no `grounding` ⇒ byte-identical to today (locked by a
baseline-equality test). core 422/422.

## 0.3.9 — W9 deterministic mutation/confirm gate

Patch across the graph (0.3.8 -> 0.3.9). Second chunk of the conversational-stability
program (ADR 0002). A confirm-before-mutate step was a `decide` node whose choice
was classified by the LLM — an off-script reply or a bare value could be
mis-classified as "confirm" and fire the mutation without an explicit human yes.
New `confirmGate()` node builder (a `DecideNode` with a `confirmGate` config — no
new node kind) whose advance decision is parsed **in code** by `parseConfirmation`,
never the model. Conservative precedence: **decline wins → interrogative/off-script
is ambiguous → affirm only when affirm-dominant**; multilingual (English + Sinhala +
Tamil, script and romanized). The runtime branches the decide dispatch on
`confirmGate` and never calls `runStructured`. Off-script/ambiguous re-asks (stay);
explicit negative routes to `onDecline`; post-END never re-fires a completed
mutation (locked by test via `hostLoop` reset + `__completedFlows`). core 415/415.

## 0.3.8 — W1 runtime recovery boundary (errors degrade, never abort)

Patch across the graph (0.3.7 -> 0.3.8). First chunk of the conversational-stability
program (ADR 0002). A tool throw, a ToolValidationError (bad args), or a
maxOscillations cap no longer aborts the session: errors degrade in-turn (safe
message + non-fatal `error` event) and route to an `escalate` node or a graceful
`error_degraded` end. New `executeModelToolCall` boundary (TextDriver+VoiceDriver),
`degradeFlowError`, TurnControl escalate/recover. core 391/391.


## 0.3.7 — Fix: global tools must be executable

`agent.globalTools` were made model-visible (0.3.6) but their executors were not
registered in the tool executor, so a model call to a global tool failed. Now
registered alongside `tools`; visibility remains gated (not exposed during
non-speaking collect extraction). Regression test `test/core-agent/global-tools.test.ts`.

## 0.3.6 — Agent base layer: base instructions + global tools in every node (ADR 0001)

Patch across the package graph (`0.3.5 → 0.3.6`).

### Added (`@kuralle-agents/core`)

- **Agent base layer composed into every flow node.** Previously each node ran
  with only its own `instructions`; the agent's global `instructions` reached just
  the off-flow host reply, so there was no shared persona/safety/grounding floor.
  Now the agent `instructions` are composed as a **prefix** into every node turn's
  system prompt (`runAgentTurn`/`runStructured`/`runExtraction`); node instructions
  layer on top. (ElevenLabs-style "base prompt regardless of active node".)
- **`AgentConfig.globalTools`** — a designated, safe allow-list of tools made
  model-visible in every **speaking** turn (e.g. a returns/FAQ KB lookup callable
  mid-flow). Safety invariant: NOT all `tools` (mutating tools stay
  flow-gated), and NOT exposed during non-speaking collect extraction.
- Implemented for TextDriver and VoiceDriver. ADR `docs/adr/0001`. core 383/383.

**Behavior change:** node prompts now also carry the agent persona/safety. Apps
that relied on nodes NOT seeing `agent.instructions` should move that text out.

## 0.3.5 — Non-speaking collect extraction (structural anti-narration backstop)

Patch across the package graph (`0.3.4 → 0.3.5`).

### Added / Fixed (`@kuralle-agents/core`)

- **`collect` extraction no longer speaks.** A collect node used to run one agent
  turn that both extracted fields AND emitted free-form prose; that prose drifted
  into claims contradicting flow state ("order placed", "visit the website", "will
  be delivered") and no prompt rule could deterministically stop it. Extraction is
  now a non-speaking operation — the **invariant**: a collect turn may change
  structured state but may NOT author user-facing text.
  - New `ChannelDriver.runExtraction` + shared `runSilentExtraction` helper: runs
    the submit tool to pull fields, emits no `text-delta`/`turn-end`, appends no
    model prose. Implemented for **TextDriver and VoiceDriver** (voice extracts via
    the text model, never speaking the realtime provider during collection).
  - New `CollectNode.ask(missing, state)`: deterministic, framework-emitted
    question for missing fields, with a safe default that never references a
    downstream outcome. `instructions` is now extraction-only (never user-visible).
- Proven model-independent via a malicious-mock model (always returns "I've
  processed your order") whose text is never emitted/appended. Voice/text parity
  (INV-3) preserved. core 381/381.

## 0.3.4 — Collect projects all collected fields to onComplete (no silent drop of optionals)

Patch across the package graph (`0.3.3 → 0.3.4`).

### Fixed (`@kuralle-agents/core`)

- **`collect` now hands `onComplete` every field it collected, not just the
  required subset.** `projectCollectData` previously projected only `node.required`,
  so optional schema fields a node extracted (e.g. a `welcome` step that classifies
  intent AND captures occasion/recipient/budget) were silently discarded before
  `onComplete` ran — making any routing that read those optionals impossible. The
  submit tool already accepts the full schema and the merge already stores all
  populated values; only the projection was lossy. It now projects all schema keys
  present in the collected data. Regression test in
  `test/core-grounding/extraction.test.ts`; full core suite 379/379, engagement
  107/107, hono-server 52/52.

## 0.3.3 — Collect grounding: one input per turn (no fabrication / no premature mutation)

Patch across the package graph (`0.3.2 → 0.3.3`). Completes the turn-by-turn flow
model so input-nodes never act on stale context.

### Fixed (`@kuralle-agents/core`)

- **`collect` nodes no longer fabricate fields from stale history.** A collect
  reached after the turn's input was already consumed by a prior node now
  **pauses** (presents its prompt, awaits the next turn) instead of running
  extraction over the whole transcript — which let a chatty model invent required
  fields (e.g. a sender name copied from the recipient). It now extracts only the
  current turn's fresh input.
- **The decide pause is now anchored to "input consumed this turn,"** not merely
  "no pending input" — so an interactive `decide` that IS the turn's first
  input-node still decides on that input (fixes a 0.3.2 edge where a withChoices
  decide as a flow's entry would wrongly pause).
- New ephemeral `RunContext.turnInputConsumed` tracks this per turn.

Net effect: a flow advances **one input-node per user turn**. Combined with
0.3.1/0.3.2, mutating steps (e.g. order creation) require an explicit
confirmation turn and fields are never inferred from old context. Regression
tests in `test/core-flow/runFlow.test.ts`; full core suite 378/378, engagement
107/107, hono-server 52/52.

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
