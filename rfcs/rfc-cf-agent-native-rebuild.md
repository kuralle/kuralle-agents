# RFC: Native Cloudflare rebuild of `@kuralle-agents/cf-agent`

**Category:** Architectural Change
**Author:** octalpixel (with Claude)
**Date:** 2026-06-04
**Status:** Draft
**Reviewers:** TBD
**Related:**
- Package under rebuild: `aria-flow/packages/kuralle-cf-agent`
- Core touched: `aria-flow/packages/kuralle-core/src/runtime/channels/TextDriver.ts`, `runtime/Runtime.ts`, `types/stream.ts`
- Reference (cloned in worktree): `_reference/cloudflare-agents/docs/{agent-class,chat-agents,state,durable-execution,sessions}.md`, `_reference/cloudflare-agents/packages/agents/src`
- Reference: `_reference/hare/packages/agent/src/hare-agent.ts`
- Memory: `project_kuralle_stability.md` (text-first decision), RFC-007 (UIMessageChunk format churn — the seam-1 bug class)

---

## Table of contents

1. Problem statement
2. Background (the 8 seams)
3. Strict requirements
4. Interface specification
5. Architecture and system dependencies
6. Pseudocode
7. Code blueprint
8. Incremental task breakdown (WBS)
9. Validation and testing
10. Security considerations
11. Rollback and abort criteria
12. Open questions

---

## 1. Problem statement

`@kuralle-agents/cf-agent` is shipped (v0.3.11) but is "not production ready and bound to fail." It runs the entire Kuralle runtime inside `AIChatAgent.onChatMessage`, then **re-encodes the AI SDK UIMessage wire protocol by hand on the way out and lossily decodes `this.messages` on the way in.** Both hand-rolled translation layers fight the Cloudflare primitives instead of using them.

Concretely, the current integration:
- hand-builds AI SDK SSE chunks (`text-start`/`text-delta`/`tool-input-available`/`text-end`) in `StreamAdapter.ts` — a reimplementation of `toUIMessageStreamResponse()` that drifts from CF's parser on every AI SDK bump (the RFC-007 bug class);
- drops tool results, system messages, message ids, and attachments when reconstructing Kuralle messages from `this.messages` (`BridgeSessionStore.ts:111`), breaking multi-turn tool reasoning;
- never streams tokens live (Kuralle buffers the whole turn then emits one consolidated `text-delta`);
- stores orchestration state in a private SQL table, throwing away CF's free client-synced `setState`;
- has no eviction recovery, and exposes none of CF's `schedule`/`queue` affordances to Kuralle flows.

**Success criteria (post-implementation, all observed on a live `wrangler dev` Worker, not just typecheck):**
- S1: A multi-turn conversation with a server tool call retains tool outputs across turns — the model sees its prior tool results (currently broken).
- S2: Assistant text streams token-by-token to the client (visible incremental deltas), not as one block at turn end.
- S3: The chat wire format is produced by the AI SDK (`createUIMessageStream`/`toUIMessageStream`), never hand-assembled. An AI SDK minor bump does not require touching Kuralle SSE-encoding code (there is none).
- S4: Current agent / current flow node / status are readable by any connected client via CF state sync with zero bespoke transport.
- S5: A DO eviction mid-turn does not lose Kuralle's effect log; the conversation recovers (resumes partial assistant text or retries the unanswered user turn) on next activation.
- S6: A Kuralle flow `action` can schedule a durable follow-up (`this.schedule`) that fires after eviction/hibernation.
- S7: Existing voice path (`src/voice/*`) continues to build and pass its current test suite, untouched in behavior.

---

## 2. Background (the 8 seams)

The division of labor stated in the current code headers is correct: **CF owns messages/persistence/transport/recovery; Kuralle owns orchestration (flows, routing, handoffs, durable effect tools).** The failures are all in the seams between them. Evidence is `file:line` in `aria-flow/packages/kuralle-cf-agent/src` and `aria-flow/packages/kuralle-core/src` unless noted.

**CF primitives (grounding, from `_reference/cloudflare-agents/docs`):** `Agent` *is* a Durable Object (`DurableObject → Server(PartyKit) → Agent`, `agent-class.md`). It provides `this.state`/`this.setState()` (JSON auto-persisted to SQLite and broadcast to every connected WS client — `state.md`), `this.sql` (sync SQLite), `this.schedule`/`this.queue` (durable alarm + task queue), lifecycle hooks, and `runFiber`/`chatRecovery` (crash recovery across eviction — `durable-execution.md`, `chat-agents.md#stream-recovery`). `AIChatAgent` (`@cloudflare/ai-chat`) extends `Agent`, owns `this.messages` (AI SDK `UIMessage[]`, auto-persisted), and you override `onChatMessage()` returning a `Response` — normally `streamText(...).toUIMessageStreamResponse()`. CF then owns persistence, **resumable streaming**, multi-client broadcast, stream recovery, data parts, and HITL approval. **Governing idea: the DO is the session; the AI SDK is the wire format.**

**`hare` lesson (`hare-agent.ts`):** it extends base `Agent`, keeps messages/status/scheduledTasks in `this.setState` (free client sync), uses `this.schedule('executeScheduledTask', …)` for follow-ups, adapts tools to an AI SDK `ToolSet`, and runs the model loop in the DO via `streamText().textStream`. The lesson is not "copy hare's bespoke transport" (it is *more* primitive than `AIChatAgent`) — it is **live inside the lifecycle and use `setState`/`schedule` natively instead of bolting on parallel machinery.**

| # | Seam | Evidence | Defect |
|---|------|----------|--------|
| S-1 | Hand-rolled wire format | `StreamAdapter.ts:20-189` emits SSE lines `text-start`/`text-delta`/`tool-input-available`/`text-end`, manually tracking `textStarted` | Reimplements `toUIMessageStreamResponse()`. Drifts from CF's `applyChunkToParts` parser on AI SDK bumps. RFC-007 recorded exactly this churn. |
| S-2 | Lossy message decode | `BridgeSessionStore.ts:111-147` `convertUIMessagesToModelMessages` keeps only `text` + `tool-call`; `KuralleAgent.ts:177-190` `getLastUserInput` keeps only text | Tool *results*, system messages, ids, attachments dropped → the model never re-sees its own tool outputs on the next turn. Multi-step tool reasoning silently breaks. |
| S-3 | No live token streaming | `TextDriver.ts:59-139`: iterates `result.fullStream` only to accumulate `draftText`; emits the whole `finalText` as one `text-delta` *after* `applyPostTurnPolicies` | True streaming is discarded *before* the bridge. **Root cause is intentional:** post-turn output policies (`TextDriver.ts:134`) can rewrite the full text, so the driver cannot stream tokens it might later redact. Any fix must resolve this tension, not ignore it. |
| S-4 | Orchestration state off CF state | `OrchestrationStore.ts` (private `cf_*` SQL table) for currentAgent/flow node/handoffs; `KuralleAgent.ts:217-235` exposes it via a bespoke `/orchestration-state` endpoint | Throws away `setState` client sync. The Studio inspector goal (live "current agent / current node") needs a custom poll instead of free WS broadcast. |
| S-5 | Session identity mismatch | `KuralleAgent.ts:98-100` `sessionId = ctx.id`; voice mints per-call sessions; `BridgeSessionStore`/`OrchestrationStore` re-keyed by `?id=` (`KuralleAgent.ts:220-233`) | Kuralle's general multi-session `SessionStore` is redundant inside one DO. The DO already *is* one session. The `?id=` bolt-on is the symptom. |
| S-6 | No eviction recovery | none | A DO evicted mid-turn loses in-flight orchestration. Note: Kuralle has its *own* durable effect log (`ctx.ts` `replayOrExecute`/`SuspendError`, `runtime/durable/*`) but it is backed by the injected `SessionStore`, **not** the DO SQLite, so it does not survive eviction in the CF deployment. CF's `chatRecovery`/`runFiber` are unused. |
| S-7 | CF affordances not surfaced | none | A Kuralle flow `action` cannot reach `this.schedule`/`this.queue`/`this.sendEmail`. "Follow up in 2h" is impossible. |
| S-8 | Cold runtime per turn | `KuralleAgent.ts:146` `createRuntime(...)` rebuilt every `onChatMessage` | No warm caches; signals the runtime does not "live in" the DO. Minor but indicative. |

**Why a rewrite, not a patch:** S-1, S-2, S-3 are the same disease — two hand-written translation layers around the AI SDK. Deleting them (consume via `convertToModelMessages`, emit via `createUIMessageStream`) collapses three seams at once but requires a core change (S-3's policy tension) and a new state model (S-4/S-5). That cross-cutting change is an architectural rebuild.

**Runner-up shapes considered (and rejected):**
- *Keep base `Agent`, roll our own chat protocol like `hare`.* Rejected: forfeits `AIChatAgent`'s resumable streaming, stream recovery, message persistence, and the `useAgentChat` React client — exactly the substrate we want CF to own.
- *Patch the StreamAdapter to track more chunk types.* Rejected: still a hand-rolled reimplementation of the AI SDK protocol; perpetuates the RFC-007 churn.

---

## 3. Strict requirements

- **REQ-1 (lossless in):** Kuralle's runtime MUST receive conversation history via the AI SDK `convertToModelMessages(this.messages)`. No bespoke UIMessage→ModelMessage converter. Tool results, system messages, ids, and non-text user parts MUST survive into the model context.
- **REQ-2 (AI-SDK-owned out):** The chat `Response` MUST be produced by the AI SDK (`createUIMessageStream` + `createUIMessageStreamResponse`, and/or `result.toUIMessageStream()`). No Kuralle code may hand-assemble `text-start`/`text-delta`/`tool-*` chunk JSON.
- **REQ-3 (live streaming):** Assistant text MUST stream incrementally to the client when no text-mutating post-turn policy is active for the speaking node. When such a policy *is* active, the driver MUST fall back to buffered emission for that node (correctness over liveness) and MUST NOT emit partial text it may later redact.
- **REQ-4 (core surface, minimal):** The kuralle-core change that enables REQ-3 MUST be additive and opt-in. Default runtime behavior (used by `hono-server` and tests) MUST be unchanged. The new behavior MUST be selectable per-run.
- **REQ-5 (state on CF):** Display-grade orchestration state (current agent id, current flow id + node, turn status, handoff count) MUST live in `this.setState` and be broadcast to clients. Bulk/working-memory and Kuralle's effect log MUST live in `this.sql` (DO SQLite), not in `setState`.
- **REQ-6 (DO is the session):** Inside a DO there is exactly one Kuralle session, keyed by the DO. The general multi-session `SessionStore` MUST be replaced by a single-session, DO-SQLite-backed store. `BridgeSessionStore` and `OrchestrationStore` are deleted.
- **REQ-7 (durable effect log in DO):** Kuralle's `RunStore` MUST be backed by DO SQLite so its effect log (exactly-once tools, signal pauses, approvals) survives eviction/hibernation.
- **REQ-8 (eviction recovery):** Each chat turn MUST run under CF `chatRecovery` so an eviction mid-stream re-enters the turn with a checkpoint and CF re-streams the persisted partial assistant message. **Exactly-once is NOT provided by `chatRecovery`/`runFiber`** — CF recovery is at-least-once-with-checkpoint (the interrupted closure is not auto-replayed; `onChatRecovery` decides resume/compensate). The **only** exactly-once authority is Kuralle's own durable effect log (REQ-7): on re-entry the runtime replays recorded tool/signal/clock effects keyed by effect id. Therefore every side-effecting tool MUST record its effect row transactionally *before* (or atomically with) the side-effect commits, or be guarded by an idempotency key — otherwise an effect executed-but-not-yet-recorded inside an interrupted turn can re-run. A re-entered turn re-invokes the model (cost/latency, possible divergence); the model stream is not an effect-log step and is recovered only by CF re-streaming the persisted UIMessage, not by Kuralle. [verified: `durable-execution.md:221-225`; `@cloudflare/ai-chat` index.ts:3732-3744]
- **REQ-9 (CF capabilities to flows):** Kuralle effect tools MUST be able to reach `this.schedule`, `this.queue`, and (optionally) `this.sendEmail` through a typed capabilities object injected into the runtime — without core depending on `cloudflare:workers`.
- **REQ-10 (voice behavior preserved):** The realtime voice path (`src/voice/*`) MUST continue to build and pass its existing tests with no behavior change. Because voice *instantiates* `BridgeSessionStore` (`withRealtimeVoice.ts:304`), it MUST be repointed to `DurableObjectSessionStore` (a behavior-preserving functional swap, gated by `bun test src/voice/__tests__`), not merely re-imported.
- **REQ-11 (no core dependency on CF):** `@kuralle-agents/core` MUST NOT import `agents`, `@cloudflare/ai-chat`, or `cloudflare:workers`. All CF coupling stays in `@kuralle-agents/cf-agent`.
- **REQ-12 (migration):** A documented migration path MUST exist for current `KuralleAgent` subclasses (`getAgents`/`getDefaultAgentId`). Public surface changes MUST be enumerated; the wrangler `new_sqlite_classes` migration story MUST be stated.

---

## 4. Interface specification

### 4.1 Core: per-run streaming mode

- **Location:** `packages/kuralle-core/src/runtime/Runtime.ts` (`RunOptions`), `types/stream.ts`
- **Signature:**
  ```ts
  // RunOptions gains:
  streaming?: 'buffered' | 'live';   // default 'buffered'
  ```
- **Behavior:** When `'live'`, the speaking `TextDriver` emits one `{type:'text-delta'}` per model chunk from `result.fullStream`, and emits `{type:'reasoning-delta'}` (new variant) if present, *provided* no text-mutating output policy is registered for the node. When `'buffered'` (default), behavior is byte-identical to today.
- **Error cases:** If `'live'` is requested but a text-mutating `OutputProcessor`/`ValidationCapability` is resolved for the node, the driver MUST silently use buffered emission for that node (logged via `hooks.onStreamPart` with a `{type:'note'}` part). No partial text is emitted.

### 4.2 Core: streaming-safe `HarnessStreamPart` additions

- **Location:** `packages/kuralle-core/src/types/stream.ts`
- **Additions to the union:**
  ```ts
  | { type: 'reasoning-delta'; text: string }          // live reasoning tokens
  | { type: 'text-start' }                              // explicit text-part boundaries
  | { type: 'text-end' }
  ```
- **Behavior:** In `'live'` mode the driver emits `text-start` before the first `text-delta` and `text-end` after the last, so the cf-agent mapping does not have to infer boundaries (deleting the brittle `textStarted` tracking in `StreamAdapter.ts:34-46`). In `'buffered'` mode these are not emitted (back-compat).
- **Error cases:** Consumers that do not understand the new variants ignore them (the cf-agent mapper switches on `type`; `hono-server`'s `toResponseStream` already passes unknown parts through as data).

### 4.3 cf-agent: `KuralleAgent`

- **Location:** `packages/kuralle-cf-agent/src/KuralleAgent.ts`
- **Shape:**
  ```ts
  abstract class KuralleAgent<Env, State extends KuralleAgentState = KuralleAgentState>
    extends AIChatAgent<Env, State> {

    protected abstract getAgents(): AgentConfig[];
    protected abstract getDefaultAgentId(): string;
    protected getRuntimeConfig(): Partial<HarnessConfig>;     // optional
    protected getStreamConfig(): Partial<StreamAdapterConfig>; // optional (data-part toggles)

    override initialState: State;                  // seeded with KuralleAgentState defaults
    override chatRecovery = true;                  // REQ-8

    async onChatMessage(onFinish, options): Promise<Response>;   // REQ-1/2/3
    protected async onChatRecovery(ctx): Promise<ChatRecoveryOptions>; // REQ-8
  }
  ```
- **Behavior of `onChatMessage`:** builds (once-cached) a `Runtime` whose `sessionStore` is a `DurableObjectSessionStore` over `this.sql`; calls `runtime.run({ input, sessionId: this.name, streaming: 'live', historyDelta: convertToModelMessages(this.messages), capabilities })`; pipes `handle.events` into a `createUIMessageStream({ execute })` writer (4.5); mirrors orchestration state into `this.setState` as parts arrive; returns `createUIMessageStreamResponse({ stream })`.
- **Error cases:** runtime throw → writer writes an error UI part and the stream closes; CF persists whatever streamed (resumable). Abort signal from `options.abortSignal` is forwarded to `runtime.run`.

### 4.4 cf-agent: `DurableObjectSessionStore`

- **Location:** `packages/kuralle-cf-agent/src/DurableObjectSessionStore.ts` (replaces `BridgeSessionStore` + `OrchestrationStore`)
- **Signature:** `class DurableObjectSessionStore implements SessionStore` — single-session, keyed by DO; persists Kuralle `RunState`/steps/working-memory in DO SQLite via the `this.sql` executor. Implements `RunStore` semantics (REQ-7).
- **Behavior:** `get()` returns the one session reconstructed from DO SQLite (NOT from CF messages — messages flow in via `historyDelta`, REQ-1). `save()` persists run/working state. Tool/signal effect rows are durable, so replay after eviction is exactly-once.
- **Error cases:** missing tables → created on first `onStart`. Corrupt row → throws (no silent reset; surfaces in logs).

### 4.5 cf-agent: `streamRuntimeToUIMessages`

- **Location:** `packages/kuralle-cf-agent/src/streamAdapter.ts` (rewrite of `StreamAdapter.ts`)
- **Signature:** `streamRuntimeToUIMessages(events: AsyncIterable<HarnessStreamPart>, writer: UIMessageStreamWriter, config: StreamAdapterConfig, hooks: { onOrchestration(part): void }): Promise<void>`
- **Behavior:** maps each `HarnessStreamPart` to an AI SDK writer call using the **SDK's own chunk types** (no hand-built JSON): `text-start`/`text-delta`/`text-end` → `writer.write` text parts; `tool-call`/`tool-result` → tool input/output parts; `handoff`/`flow-*`/`node-*` → `writer.write({type:'data-handoff'|'data-flow-node'|…})`; orchestration parts also call `hooks.onOrchestration` so `KuralleAgent` can `setState`. `done` is a no-op (CF closes the stream).
- **Error cases:** `error` part → `writer.write({type:'data-error', …})` and rethrow so the fiber records the failure for recovery.

### 4.6 cf-agent: `KuralleAgentState`

- **Location:** `packages/kuralle-cf-agent/src/types.ts`
- **Shape (REQ-5, kept small per `state.md`):**
  ```ts
  interface KuralleAgentState {
    currentAgentId: string;
    flow: { flowId: string; nodeName: string } | null;
    status: 'idle' | 'thinking' | 'streaming' | 'paused' | 'error';
    handoffCount: number;
    lastError: string | null;
  }
  ```
- **Behavior:** updated via `this.setState` from `onOrchestration` and turn lifecycle. Working memory, message history, and effect log are NOT here — they are in `this.sql` / `this.messages`.

### 4.7 cf-agent: `CloudflareCapabilities`

- **Location:** `packages/kuralle-cf-agent/src/capabilities.ts`; consumed via a core-side typed slot.
- **Core slot (REQ-9, REQ-11):** add `capabilities?: RuntimeCapabilities` to `HarnessConfig`, where `RuntimeCapabilities` is a *core-defined interface* (no CF import):
  ```ts
  interface RuntimeCapabilities {
    schedule?(when: Date | number | string, method: string, payload?: unknown): Promise<{ id: string }>;
    enqueue?(method: string, payload?: unknown): Promise<void>;
    sendEmail?(msg: EmailMessage): Promise<void>;
  }
  ```
- **cf-agent impl:** `createCloudflareCapabilities(agent: KuralleAgent)` returns an object delegating to `agent.schedule`/`agent.queue`/`agent.sendEmail`. Kuralle effect tools read `ctx` capabilities to schedule durable follow-ups.
- **Error cases:** capability undefined (non-CF runtime) → tool that needs it throws a typed `CapabilityUnavailableError`.

---

## 5. Architecture and system dependencies

### 5.1 Structural changes

**Deleted:** `BridgeSessionStore.ts`, `OrchestrationStore.ts`, hand-rolled `StreamAdapter.ts`, the `/orchestration-state` endpoint, the lossy `convertUIMessagesToModelMessages`/`getLastUserInput`.

> **Coupling caught (verified):** the voice path does not merely type-import `BridgeSessionStore` — it **instantiates** `new BridgeSessionStore({...})` at `src/voice/withRealtimeVoice.ts:304`. Deleting it therefore forces a *functional* repoint of voice to `DurableObjectSessionStore`, not a cosmetic import swap. C10 owns this, gated by the existing voice test suite (REQ-10). `DurableObjectSessionStore` MUST accept a constructor surface compatible with the voice call site (or ship a thin `BridgeSessionStore`-shaped shim over it) so the swap is behavior-preserving.

**Created (cf-agent):** `DurableObjectSessionStore.ts` (4.4), `streamAdapter.ts` (4.5, AI-SDK-writer based), `capabilities.ts` (4.7), `KuralleAgentState` (4.6).

**Modified (core):** `RunOptions.streaming` (4.1), `HarnessStreamPart` additions (4.2), `TextDriver` live-emit path (4.1/4.3 behavior), `HarnessConfig.capabilities` (4.7), a core `RunStore` interface confirmation for DO backing (REQ-7).

```
BEFORE                                   AFTER
client ─WS→ AIChatAgent.onChatMessage     client ─WS→ AIChatAgent.onChatMessage
   │  this.messages ─(lossy)→ Bridge         │  convertToModelMessages(this.messages)
   │  Runtime.run → HarnessStreamPart        │            │  historyDelta
   │  StreamAdapter (hand SSE) ─→ CF parse    │  Runtime.run(streaming:'live')
   │  OrchestrationStore (private SQL)        │  events → createUIMessageStream writer → CF
                                             │  orchestration parts → this.setState (synced)
                                             │  RunStore + working mem → this.sql (durable)
                                             │  turn under chatRecovery (fiber)
```

### 5.2 Service and library dependencies

- `@cloudflare/ai-chat` (`AIChatAgent`, `createUIMessageStreamResponse` types, `ChatRecoveryContext/Options`), `agents` (peer), `ai` (`convertToModelMessages`, `createUIMessageStream`, `UIMessageStreamWriter`). No new external services. **Verified:** installed `ai@6.0.193` exports `convertToModelMessages`, `createUIMessageStream`, `createUIMessageStreamResponse` (all functions) — REQ-1/REQ-2 rest on confirmed surface, not assumption.
- Core gains no new deps (REQ-11). `convertToModelMessages` is already a peer of cf-agent via `ai`.

### 5.3 Data and schema changes

- DO SQLite tables owned by Kuralle inside the DO: `kuralle_run_state`, `kuralle_steps`, `kuralle_working_memory` (created in `onStart`). CF owns `cf_ai_chat_agent_messages`, `cf_agents_state`, `cf_agents_schedules`, etc.
- `this.setState` schema = `KuralleAgentState` (4.6).
- wrangler: unchanged shape — `new_sqlite_classes: ["<Subclass>"]` already required. **Breaking for existing deployments:** the private `OrchestrationStore` table is abandoned; a one-line note in migration docs (orchestration state resets once; messages are unaffected since CF owns them).

### 5.4 Network and performance considerations

- Live streaming reduces time-to-first-token from "whole turn" to "first model chunk" (S2).
- `setState` broadcasts on each orchestration transition — bounded (a handful per turn); state is intentionally tiny (4.6) per `state.md` "keep state small."
- Warm `Runtime` cached on the DO instance (REQ via 5.1) removes per-turn `createRuntime` cost (S-8).

---

## 6. Pseudocode

### 6.1 `onChatMessage` (cf-agent)

```
FUNCTION onChatMessage(onFinish, options):
    runtime = this.getOrBuildRuntime()           # cached on DO instance
    all = await convertToModelMessages(this.messages)   # REQ-1, ASYNC in ai@6.x; lossless for TERMINAL tool parts only
    history = all[:-1]                                   # exclude trailing user turn (single source of truth)
    input  = trailingUserContent(this.messages)         # the turn; carried once, not duplicated into history

    handle = runtime.run({
        sessionId: this.name,                     # DO is the session, REQ-6
        historyDelta: history,
        streaming: 'live',                        # REQ-3
        abortSignal: options.abortSignal,
        capabilities: createCloudflareCapabilities(this),  # REQ-9
    })

    stream = createUIMessageStream(execute = async ({ writer }):
        await streamRuntimeToUIMessages(handle.events, writer, this.streamConfig,
            onOrchestration = (part) => this.applyOrchestration(part))   # REQ-5 setState
    )
    RETURN createUIMessageStreamResponse({ stream })   # REQ-2, CF owns persistence/resume/recovery
```

### 6.2 `TextDriver` live emission (core, REQ-3 tension resolved)

```
FUNCTION runAgentTurn(node, ctx):
    ...
    liveOK = (ctx.streaming == 'live') AND NOT hasTextMutatingPolicy(node, ctx)

    FOR step IN 0..maxSteps:
        result = streamText({ model, system, messages, tools, abortSignal })
        IF liveOK:
            emittedTextStart = false
            FOR await part IN result.fullStream:
                IF part.type == 'text-delta':
                    IF NOT emittedTextStart: ctx.emit({type:'text-start'}); emittedTextStart = true
                    ctx.emit({type:'text-delta', text: part.text})    # live tokens
                    draftText += part.text
                ELSE IF part.type == 'reasoning-delta':
                    ctx.emit({type:'reasoning-delta', text: part.text})
                ELSE IF part.type == 'error': emit+throw
            IF emittedTextStart: ctx.emit({type:'text-end'})
        ELSE:
            FOR await part IN result.fullStream: draftText += part.text  # buffered (today's path)
        ... tool-call / tool-result loop unchanged ...

    postText = applyPostTurnPolicies(ctx, draftText, toolCallsMade)
    IF NOT liveOK AND postText:
        ctx.emit({type:'text-delta', text: postText})   # buffered emit (today's behavior)
    # liveOK path already streamed; if a policy WOULD mutate, liveOK was false → we are here.
    ctx.emit({type:'turn-end'})
```

### 6.3 Recovery (cf-agent, REQ-8)

```
FUNCTION onChatRecovery(ctx):
    # CF re-streams the persisted partial assistant message. The runtime, on
    # turn re-entry, REPLAYS Kuralle's OWN effect log (REQ-7) so recorded
    # tool/signal effects are exactly-once; UNRECORDED in-flight effects re-run
    # (mitigated by transactional effect-record-before-commit / idempotency key).
    # chatRecovery itself is at-least-once-with-checkpoint, NOT exactly-once.
    IF (now - ctx.createdAt) > STALE_MS: RETURN { continue: false }   # guard stale; reconcile STALE_MS vs CF 5min/15min windows
    RETURN {}    # default: persist partial + continue
```

---

## 7. Code blueprint

### 7.1 `KuralleAgent.onChatMessage` (cf-agent)

```ts
// packages/kuralle-cf-agent/src/KuralleAgent.ts
import { AIChatAgent, type OnChatMessageOptions, type ChatRecoveryContext, type ChatRecoveryOptions } from '@cloudflare/ai-chat';
import { convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, type StreamTextOnFinishCallback, type ToolSet } from 'ai';
import { createRuntime, type AgentConfig, type HarnessConfig, type Runtime } from '@kuralle-agents/core';
import { DurableObjectSessionStore } from './DurableObjectSessionStore.js';
import { streamRuntimeToUIMessages } from './streamAdapter.js';
import { createCloudflareCapabilities } from './capabilities.js';
import { DEFAULT_STREAM_CONFIG, type KuralleAgentState, type StreamAdapterConfig } from './types.js';

export abstract class KuralleAgent<Env = unknown, State extends KuralleAgentState = KuralleAgentState>
  extends AIChatAgent<Env, State> {

  protected abstract getAgents(): AgentConfig[];
  protected abstract getDefaultAgentId(): string;
  protected getRuntimeConfig(): Partial<HarnessConfig> { return {}; }
  protected getStreamConfig(): Partial<StreamAdapterConfig> { return {}; }

  override chatRecovery = true;                          // REQ-8
  private _runtime: Runtime | null = null;

  override onStart() {
    // Kuralle-owned DO SQLite tables (REQ-7). this.sql is the AIChatAgent tagged template.
    new DurableObjectSessionStore(this.sql.bind(this), this.name).ensureSchema();
  }

  private runtime(): Runtime {
    if (this._runtime) return this._runtime;            // warm per DO instance (S-8)
    this._runtime = createRuntime({
      ...this.getRuntimeConfig(),
      agents: this.getAgents(),
      defaultAgentId: this.getDefaultAgentId(),
      sessionStore: new DurableObjectSessionStore(this.sql.bind(this), this.name),
    });
    return this._runtime;
  }

  async onChatMessage(_onFinish: StreamTextOnFinishCallback<ToolSet>, options?: OnChatMessageOptions): Promise<Response> {
    // convertToModelMessages is ASYNC in ai@6.0.193 (Promise<ModelMessage[]>) — MUST await (BLOCKER fix).
    // Lossless only for tool parts in a TERMINAL state (output-available/-error/-denied);
    // input-streaming parts are dropped (index.d.ts ignoreIncompleteToolCalls). See REQ-1.
    const all = await convertToModelMessages(this.messages);
    const history = all.slice(0, -1);                               // REQ-1: exclude the trailing user turn...
    const input = trailingUserContent(this.messages);              // ...carry it once as `input` (no double-count)

    const handle = this.runtime().run({
      sessionId: this.name,                                          // REQ-6
      input,
      historyDelta: history,                                         // prior transcript only
      streaming: 'live',                                             // REQ-3
      userId: (options?.body as { userId?: string })?.userId,
      abortSignal: options?.abortSignal,
      capabilities: createCloudflareCapabilities(this),             // REQ-9
    });

    const cfg = { ...DEFAULT_STREAM_CONFIG, ...this.getStreamConfig() };
    const stream = createUIMessageStream({                          // REQ-2
      execute: async ({ writer }) => {
        await streamRuntimeToUIMessages(handle.events, writer, cfg, {
          onOrchestration: (p) => this.applyOrchestration(p),       // REQ-5
        });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  private applyOrchestration(p: HarnessStreamPart) {
    if (p.type === 'handoff') this.setState({ ...this.state, currentAgentId: p.targetAgent, handoffCount: this.state.handoffCount + 1 });
    else if (p.type === 'node-enter') this.setState({ ...this.state, flow: { ...(this.state.flow ?? { flowId: '' }), nodeName: p.nodeName } });
    else if (p.type === 'flow-enter') this.setState({ ...this.state, flow: { flowId: p.flow, nodeName: '' } });
    // status transitions handled at turn boundaries
  }

  protected async onChatRecovery(ctx: ChatRecoveryContext): Promise<ChatRecoveryOptions> {
    if (Date.now() - ctx.createdAt > 2 * 60_000) return { continue: false };  // chat-agents.md guard
    return {};
  }
}
```

### 7.2 `streamRuntimeToUIMessages` (cf-agent — AI SDK owns the wire)

```ts
// packages/kuralle-cf-agent/src/streamAdapter.ts
import type { UIMessageStreamWriter } from 'ai';
import type { HarnessStreamPart } from '@kuralle-agents/core';

export async function streamRuntimeToUIMessages(
  events: AsyncIterable<HarnessStreamPart>,
  writer: UIMessageStreamWriter,
  cfg: StreamAdapterConfig,
  hooks: { onOrchestration(p: HarnessStreamPart): void },
): Promise<void> {
  for await (const p of events) {
    switch (p.type) {
      case 'text-start': writer.write({ type: 'text-start', id: 't' }); break;       // SDK chunk types
      case 'text-delta': writer.write({ type: 'text-delta', id: 't', delta: p.text }); break;
      case 'text-end':   writer.write({ type: 'text-end', id: 't' }); break;
      case 'reasoning-delta': writer.write({ type: 'reasoning-delta', id: 'r', delta: p.text }); break;
      case 'tool-call':  writer.write({ type: 'tool-input-available', toolCallId: p.toolCallId!, toolName: p.toolName, input: cfg.includeToolArgs ? p.args : undefined }); break;
      case 'tool-result': writer.write({ type: 'tool-output-available', toolCallId: p.toolCallId!, output: p.result }); break;
      case 'handoff': if (cfg.includeHandoffs) writer.write({ type: 'data-handoff', data: { to: p.targetAgent, reason: p.reason } }); hooks.onOrchestration(p); break;
      case 'flow-enter': case 'node-enter': case 'node-exit': case 'flow-transition': case 'flow-end':
        if (cfg.includeFlowEvents) writer.write({ type: `data-${p.type}` as const, data: p as object }); hooks.onOrchestration(p); break;
      case 'error': writer.write({ type: 'data-error', data: { error: p.error } }); throw new Error(p.error);
      case 'done': case 'turn-end': case 'paused': case 'interrupted': case 'conversation-outcome': case 'interactive': break;
    }
  }
}
```
> Note: this still switches on Kuralle part types, but every emitted object is an AI SDK chunk shape passed to the SDK writer — the SDK serializes and CF parses what the SDK produced. The brittle hand-tracked `text-start`/`text-end` lifecycle (old `StreamAdapter.ts:34-46`) is gone because the core now emits explicit boundaries (4.2). **Open question Q1 weighs replacing this entirely with `writer.merge(result.toUIMessageStream())` passthrough.**

### 7.3 Capabilities (no CF import in core)

```ts
// packages/kuralle-core/src/types/capabilities.ts  (core, REQ-11)
export interface RuntimeCapabilities {
  schedule?(when: Date | number | string, method: string, payload?: unknown): Promise<{ id: string }>;
  enqueue?(method: string, payload?: unknown): Promise<void>;
  sendEmail?(msg: unknown): Promise<void>;
}

// packages/kuralle-cf-agent/src/capabilities.ts  (cf-agent)
export function createCloudflareCapabilities(agent: { schedule: Function; queue: Function; sendEmail?: Function }): RuntimeCapabilities {
  return {
    schedule: (when, method, payload) => agent.schedule(when as never, method, payload),
    enqueue: (method, payload) => agent.queue(method, payload),
    sendEmail: agent.sendEmail ? (m) => agent.sendEmail!(m) : undefined,
  };
}
```

---

## 8. Incremental task breakdown (WBS)

| ID | Chunk | Files | Grounding | Acceptance criteria |
|----|-------|-------|-----------|---------------------|
| C1 | Add `streaming` to `RunOptions`; thread to ctx/driver | `core/runtime/Runtime.ts`, `runtime/ctx.ts`, `types/run-context.ts` | REQ-4 | `streaming:'buffered'` default; existing core tests green unchanged |
| C2 | `HarnessStreamPart` += `text-start`/`text-end`/`reasoning-delta` | `core/types/stream.ts` | REQ-2 | typechecks; voice union untouched; `toResponseStream` passes new parts |
| C3 | `TextDriver` live-emit path + `hasTextMutatingPolicy` guard | `core/runtime/channels/TextDriver.ts`, `runtime/policies/agentTurn.ts` | REQ-3, test:textdriver_live | new test: live mode emits ≥2 `text-delta` for a 2-chunk model; buffered mode emits exactly 1 (regression) |
| C4 | `RuntimeCapabilities` interface + `HarnessConfig.capabilities` + ctx access | `core/types/capabilities.ts`, `runtime/Runtime.ts`, `runtime/ctx.ts` | REQ-9, REQ-11 | core has zero CF imports (grep gate); effect tool can read `ctx` capability |
| C5 | `DurableObjectSessionStore` (single-session, DO-SQLite RunStore) | `cf-agent/src/DurableObjectSessionStore.ts` | REQ-6, REQ-7, test:do_session_roundtrip | unit: save→get round-trips RunState + a recorded tool step; replay is exactly-once |
| C6 | Rewrite stream adapter to AI SDK writer | `cf-agent/src/streamAdapter.ts` | REQ-2, test:adapter_uimessages | unit: feeding a fixed `HarnessStreamPart[]` produces valid AI SDK chunks (snapshot) |
| C7 | `KuralleAgentState` + `applyOrchestration` setState | `cf-agent/src/types.ts`, `KuralleAgent.ts` | REQ-5 | state updates observed via a 2nd WS client during a handoff |
| C8 | New `KuralleAgent` (`onChatMessage`, warm runtime, recovery) | `cf-agent/src/KuralleAgent.ts`, `index.ts` | REQ-1,2,8, test:chat_e2e | delete `BridgeSessionStore`/`OrchestrationStore`; multi-turn tool test S1 passes |
| C9 | `createCloudflareCapabilities` + a `schedule` effect-tool example | `cf-agent/src/capabilities.ts`, `cf-agent/examples/*` | REQ-9, S6 | example schedules a follow-up that fires after hibernation (live smoke) |
| C10 | Repoint voice from `new BridgeSessionStore` (`withRealtimeVoice.ts:304`) to `DurableObjectSessionStore` (keyed by call id, Q3) — behavior-preserving | `cf-agent/src/voice/withRealtimeVoice.ts`, `RealtimeVoiceAgent.ts` | REQ-10 | `bun test src/voice/__tests__` green; no behavior delta |
| C11 | Live smoke example + README/migration docs | `cf-agent/examples/cf-chat-native/*`, `README.md` | REQ-12, S1-S6 | `wrangler dev` smoke checklist (§9.3) passes end-to-end |
| C12 | Version + publish graph note (pnpm `-r`) | changeset | gotcha: version together | core+cf-agent versioned and built together |

Dependency order: C1→C2→C3 (core streaming); C4 parallel; C5→C6→C7→C8 (cf-agent); C9 after C8; C10 after C8; C11 after C9/C10; C12 last.

## 9. Validation and testing

### 9.0 Validation contract (assertion IDs)

| ID | Source | Assertion |
|----|--------|-----------|
| REQ-1 | §3 | model context after turn 2 contains turn-1 tool output (lossless) |
| REQ-2 | §3 | no string `'text-delta'` JSON literal hand-built in cf-agent src (grep gate); all chunks via SDK writer |
| REQ-3 | §3 | live mode streams ≥2 deltas; policy-mutating node falls back to buffered, no partial emitted |
| REQ-4 | §3 | core default `'buffered'`; full core suite green unchanged |
| REQ-5 | §3 | 2nd WS client sees `currentAgentId` change on handoff |
| REQ-7/8 | §3 | recorded tool step not re-executed after simulated eviction |
| REQ-11 | §3 | `grep -r "cloudflare:workers\|@cloudflare/ai-chat\|from 'agents'" core/src` → empty |
| test:textdriver_live | §9.1 | C3 test |
| test:do_session_roundtrip | §9.1 | C5 test |
| test:adapter_uimessages | §9.1 | C6 snapshot test |
| test:chat_e2e | §9.1 | multi-turn tool conversation |
| cmd:wrangler_smoke | §9.3 | live Worker checklist |

### 9.1 Fail-to-pass tests
- `test:textdriver_live` — live mode emits multiple `text-delta`; buffered emits one (asserts S2 + back-compat).
- `test:do_session_roundtrip` — `DurableObjectSessionStore` persists/loads `RunState` and a recorded step in a SQLite test harness (miniflare/`vitest-pool-workers`); replay does not re-run the effect.
- `test:adapter_uimessages` — fixed `HarnessStreamPart[]` → expected AI SDK chunk sequence (snapshot).
- `test:chat_e2e` — two turns: turn 1 calls a server tool; turn 2's `convertToModelMessages` input includes the tool output (asserts REQ-1/S1).

### 9.2 Regression (pass-to-pass)
- `bun run test` (full core suite) — unchanged behavior with default `'buffered'`.
- `bun test packages/kuralle-cf-agent/src/voice/__tests__` — voice untouched (REQ-10).
- `bun run typecheck:all`.

### 9.3 Validation commands (live smoke — the real gate, not typecheck)
```bash
# In a CF example app (examples/cf-chat-native), neutral cwd to avoid config.load() error:
cd packages/kuralle-cf-agent/examples/cf-chat-native && wrangler dev &
# 1. multi-turn tool memory (S1) + live streaming (S2): a WS client script
bun run scripts/smoke-chat.ts            # asserts incremental deltas + tool output retained turn-to-turn
# 2. state sync (S4): open two WS clients; client B observes currentAgentId change when A triggers a handoff
bun run scripts/smoke-state.ts
# 3. scheduled follow-up (S6): schedule(+5s); force DO idle; confirm callback fires
bun run scripts/smoke-schedule.ts
# 4. recovery (S5): kill the DO mid-stream (wrangler) ; reconnect ; confirm resume, no double tool-exec
bun run scripts/smoke-recovery.ts
```

## 10. Security considerations
- No new external attack surface: same WS/HTTP entrypoints as `AIChatAgent`. Tool approval (`needsApproval`, `ctx.ts:194-202`) remains enforced in the runtime; CF HITL approval is additive (future).
- `capabilities.schedule`/`enqueue` execute named DO methods — restrict the dispatcher to an allowlist of method names (mirror hare's `executeScheduledTask` switch); never `eval` a payload-supplied method name.
- `setState` is broadcast to all connected clients — `KuralleAgentState` (4.6) carries no secrets/PII (ids and status only). Working memory stays server-side in `this.sql`.

## 11. Rollback and abort criteria
- **Abort if** the core `streaming:'live'` path cannot preserve buffered behavior under default (any core regression in `bun run test`) → the core change is not additive; stop and redesign C1-C3 before touching cf-agent.
- **Abort if** `convertToModelMessages(this.messages)` cannot round-trip Kuralle's tool message shape (REQ-1 fails the e2e) → this is the load-bearing assumption; re-triage message mapping before proceeding.
- **Rollback:** the rebuild lands behind a new major of `@kuralle-agents/cf-agent`; the prior `0.3.x` remains installable. No data migration beyond the abandoned orchestration table (messages are CF-owned and unaffected).
- **Symptom-patch guard:** if live streaming "works" only by disabling post-turn policies globally, that is a symptom patch — REQ-3's per-node fallback is mandatory; do not weaken policies to get streaming.

## 12. Open questions

- **Q1 (passthrough vs mapped stream):** Should §7.2 map parts to SDK chunks, or should core expose the raw `result.toUIMessageStream()` so cf-agent does `writer.merge(...)` verbatim (gaining reasoning/source/file parts for free)? Tradeoff: *mapped* keeps `HarnessStreamPart` as the single bus type and works for `hono-server` too, but must enumerate chunk kinds; *passthrough* is byte-perfect to the AI SDK but threads a `ReadableStream` value through the single-consumer event bus and couples core's stream type to AI SDK `UIMessageChunk`.
  **Proposal (REVISED after deep-dive — 3 dimensions converged):** make **passthrough the default for the cf-agent path**. The mapped switch in §7.2 reproduces the exact RFC-007 disease it claims to delete — a hand-maintained enumeration of AI SDK chunk kinds that drifts on every SDK bump, and it silently drops `reasoning`/`source-url`/`source-document`/`file` parts (relevant to the framework's "grounding is explicit if promised" rule). Instead: core exposes the speaking node's `result.toUIMessageStream()` as a passthrough, and cf-agent does `writer.merge(result.toUIMessageStream())` so the **SDK owns the full chunk vocabulary**; the hand-mapping is reserved ONLY for orchestration `data-*` parts that have no SDK equivalent. `hono-server` keeps the mapped `HarnessStreamPart` bus independently (it does not need the rich parts). This makes REQ-2 fully true, not half-true. Cost: core's stream surface must carry a `ReadableStream<UIMessageChunk>` for the speaking turn — acceptable since cf-agent consumes it once. [verified viable: `toUIMessageStream()` on `StreamTextResult`, `UIMessageStreamWriter.merge` accepts it]
- **Q2 (post-turn policy + live streaming):** When a node has a text-mutating output policy, we fall back to buffered (REQ-3). Is silent fallback acceptable, or should the client be told the turn is non-streaming?
  **Proposal:** silent fallback for v1 (correctness preserved, no partial leak); emit a transient `data-buffered` part (ignored by clients that do not handle it) so advanced UIs can show a spinner instead of waiting for tokens. Revisit moving guardrails to streaming `wrapLanguageModel` middleware (per-chunk redaction) as a separate RFC.
- **Q3 (voice scope):** Voice **instantiates** `BridgeSessionStore` at `withRealtimeVoice.ts:304` and mints per-call sessions inside the DO (the `?id=` path). REQ-6 collapses chat to one-session-per-DO. Does voice genuinely need multiple sessions per DO, or can it share `DurableObjectSessionStore` keyed by call id?
  **Proposal:** make `DurableObjectSessionStore` accept an explicit session key (defaulting to `this.name` for chat). Voice passes its per-call id as the key, preserving today's multi-call-per-DO behavior through one store class — this lets C10 be a behavior-preserving swap (gated by voice tests) without a separate voice RFC. If voice tests reveal a semantic the single class cannot model, *then* scope a voice-on-CF RFC. This keeps voice in REQ-10 (behavior preserved) rather than out of scope.
- **Q4 (RunStore backing detail):** `DurableObjectSessionStore` must implement Kuralle's `RunStore` over sync DO SQLite, but `ctx.ts` uses `await`-ed store calls. Is the existing `RunStore` interface async-compatible with the sync `this.sql` (wrap in resolved promises)?
  **Proposal:** yes — wrap sync `this.sql` results in `Promise.resolve`; the `RunStore` interface is already async, so a DO-backed impl that resolves immediately is conformant. Confirm during C5 against `runtime/durable/RunStore.ts`.

---

## 13. Deep-dive audit reconciliation

A 5-dimension independent-read + adversarial-audit workflow (10 agents, re-deriving facts from CF docs, the `agents`/`@cloudflare/ai-chat` source, kuralle-core, hare, and the installed `ai@6.0.193` `.d.ts`) reviewed this RFC. It **confirmed** the core diagnosis: all 8 seams verified verbatim at `file:line`; REQ-1/2/5/6/9/11 sound; Q4 sound; the hare anti-pattern rejections independently validated. It found 2 blockers and several majors, dispositioned below.

### 13.1 Blockers (fixed inline)

| ID | Finding | Disposition |
|----|---------|-------------|
| B1 | **Recovery exactly-once framing wrong.** `chatRecovery`/`runFiber` is at-least-once-with-checkpoint; the interrupted closure is not auto-replayed. Exactly-once comes only from Kuralle's own effect log. [`durable-execution.md:221-225`; ai-chat index.ts:3732-3744] | **Fixed:** REQ-8 + §6.3 rewritten. Exactly-once = Kuralle effect log (record-before-commit / idempotency key); CF only re-streams persisted partial + re-enters turn (model re-invokes). New §9.1 test required (B1-test below). |
| B2 | **`convertToModelMessages` is async** (`Promise<ModelMessage[]>`) in ai@6.0.193 — RFC called it synchronously. [verified `dist/index.d.ts:3954`] | **Fixed:** §6.1 + §7.1 now `await`. C8 acceptance must catch the missing await. |

### 13.2 Majors (design/contract — must close before/within the cited chunk)

| ID | Finding | Disposition |
|----|---------|-------------|
| M1 | **Q1 should default to passthrough, not mapped** (3 dimensions). Mapped reproduces RFC-007 churn + drops reasoning/source/file parts. | **Adopted:** Q1 revised to passthrough-default (`writer.merge(result.toUIMessageStream())`); mapping only for orchestration `data-*`. Cascades into §4.5/§7.2/C6 — rework the adapter to merge, not switch. |
| M2 | **Streaming gate is per-AGENT, not per-node.** `resolveAgentPolicies(opened.agent)` sets policies once on ctx; no per-node registration exists. ANY output/validation/refinement policy → buffered, defeating S2 for guarded agents. **UPDATE (post-hardening, 0.3.18):** the policy entry-point is now SHIPPED — `resolvePolicies.ts:24-25` reads `agent.validate`/`agent.refine` (H6). And `applyPostTurnPolicies` now returns `{confidence, control, text}` and can BLOCK/REROUTE (`TextDriver.ts:135-139`), so the buffer-then-gate is load-bearing, not hypothetical. | **Amend REQ-3/§4.1/§6.2/C3:** rename `hasTextMutatingPolicy(node)` → `hasOutputMutatingPolicy(ctx)`, define as `(ctx.outputProcessors.length + ctx.validationPolicies.length + ctx.refinementPolicies.length)===0`. State S2 holds ONLY for runs with zero output/validation/refine policies. In `liveOK` mode, SKIP `applyPostTurnPolicies` and set `out.text = draftText` (provable streamed==persisted). The buffered fallback is now the COMMON path for any agent using H6's confidence/grounding gate. |
| M3 | **`input` vs `historyDelta` double-count** the trailing user turn (it is in `this.messages` already). | **Fixed (contract b):** §6.1/§7.1 now `history = all.slice(0,-1)` + `input = trailingUserContent(...)`. C8/e2e MUST assert the turn-N user message appears exactly once in model context. Needs `RunOptions.input` to carry non-text parts losslessly (widen, or use `seedMessages`). |
| M4 | **No tool-pair-aware trimming.** Raw `convertToModelMessages` grows unbounded; a naive slice orphans a tool-result whose tool-call was trimmed → provider 400s. | **Amend REQ-1/§4.3:** add `pruneMessages({ toolCalls:'before-last-2-messages', reasoning:'before-last-message' })` (or a pair-aware trimmer in the driver) between convert and `streamText`. Storage cap (`maxPersistedMessages`) is separate from LLM-context cap. New fail-to-pass test: long transcript must not orphan a tool-result. |
| M5 | **`chatRecovery` may silently no-op.** Its progress counter is bumped in the base class `_storeStreamChunk` reader loop. Returning our own `createUIMessageStreamResponse({stream})` (vs `result.toUIMessageStreamResponse()`) may bypass that loop → recovery never engages despite `chatRecovery=true`. | **Add C11/§9.3 live gate:** on `wrangler dev`, assert the recovery progress counter ADVANCES with our writer path (not just "reconnect succeeds"). If it does not engage, return the SDK's own Response or drive chunk storage explicitly. Reconcile `STALE_MS=2min` with CF's 5min/15min windows. |
| M6 | **`DurableObjectSessionStore` constructor fork.** §7.1 uses positional `(sql, name)`; voice calls object-arg `new BridgeSessionStore({ sqlExecutor, cfMessages, sessionId, defaultAgentId })`. C10 can't be behavior-preserving across two shapes. | **Pin one ctor in §4.4** carrying an explicit session key + optional `cfMessages` (voice) vs `historyDelta` (chat) source; use it in BOTH §7.1 and C10. |
| M7 | **Voice per-call keying is a regression guard, not a convenience.** A prior `'default'` sentinel key caused cross-call state leak ("flow stuck at confirm on 2nd call"). | **Promote Q3 to hard REQ-6 clause:** chat = one-session-per-DO; voice MUST retain per-call-id keying. Add a voice multi-call regression test to the C10 gate. |
| M8 | **Public API delta incomplete (REQ-12).** Removed public exports not enumerated: `BridgeSessionStore`, `OrchestrationStore`, `createSSEResponse`, `OrchestrationState`, `SqlExecutor`, `CfChatAgent` alias; and the `./voice` subpath surface is unmentioned. | **Add an API-delta table to §5.3/§12** listing every removed/replaced export and whether `./voice` surface changes. (New major makes removal legal; enumeration is still required.) |
| M9 | **Multi-client streaming asymmetry.** Only the ORIGINATING client gets live token deltas; other clients get the final `CF_AGENT_CHAT_MESSAGES` broadcast on completion. `setState` IS live to all. [`chat-agents.md:1584`] | **Document in §2/§5.4 + S2/S4:** orchestration state streams live to all clients; assistant TEXT streams live only to the originator. A multi-observer live transcript is NOT free from AIChatAgent — scope separately if it's a product goal. `smoke-state.ts` asserts only setState on client B. |
| M10 | **REQ-1 losslessness is conditional.** `convertToModelMessages` drops tool parts NOT in a terminal state (`ignoreIncompleteToolCalls`; input-streaming guard). | **Qualify REQ-1:** losslessness holds for tool parts in terminal state. `test:chat_e2e` must assert turn-1's tool part is `output-available` at turn-2 convert time AND its output appears in the result. |
| M11 | **Assistant tool/reasoning parts must actually persist into `this.messages` as UIMessage parts** — not merely be readable next turn. (hare's exact failure: persists only final text.) | **Add requirement + test (C8):** observe via the base-class `persistMessages` path that turn-1's `tool-input-available`/`tool-output-available`/`reasoning` parts are persisted and present in turn-2 `this.messages`. |

### 13.3 Minors (note or guard; non-blocking)

- **reasoning-delta is unverified SDK surface** — drop from v1 (text-start/delta/end suffice for S2) OR verify `fullStream` yields it + writer accepts it before C2/C3. If kept, add `reasoning-start`/`reasoning-end` bracketing (mirrors text).
- **Hardcoded chunk ids `'t'`/`'r'`** across multi-step turns can make CF's `applyChunkToParts` mis-merge parts — generate a fresh id per text/reasoning cycle (per step). C6 snapshot must cover a 2-text-part turn. *(Mostly mooted if M1 passthrough lands — the SDK assigns ids.)*
- **`tool-input-available` with `input: undefined`** (when `includeToolArgs` false) may be malformed — omit the field or pass `{}`; pin in C6 both ways.
- **§4.5/Q1 wording:** `createUIMessageStream` returns a `ReadableStream`; the writer comes from the `execute({ writer })` callback (the §7.1 code is already correct).
- **MCP post-hibernation race:** if `getAgents()` uses MCP tools, `await this.mcp.waitForConnections()` before assembling the tool set, or document MCP out-of-scope for v1; gate the warm-runtime cache accordingly.
- **`durable-agent-surface.ts` `as` cast** is a silent CF-coupling seam (erases type-checking on a CF SDK bump) — pin `agents`/`@cloudflare/ai-chat` versions and add a runtime field-presence smoke.
- **Import path:** use `@cloudflare/ai-chat`, NOT the deprecated `agents/ai-chat-agent` re-export (add to grep gate).
- **`this.sql` return SHAPE** (array, not cursor needing `.toArray()`) is a prior real break — C5 must verify against the installed `agents` version before building RunStore on it.
- **Adopt-don't-reinvent:** select a `messageConcurrency` mode (likely `'queue'` or `'latest'`) for overlapping submits mid-stream; use `onChatResponse` as the canonical turn-terminal hook for `status:'idle'` setState instead of inferring boundaries in `applyOrchestration`.
- **setState broadcast frequency:** CF broadcasts FULL state per `setState`; firing per `node-enter` interleaves many broadcasts with the token stream — coalesce to turn boundaries / meaningful-change only.
- **EventBus replay:** live mode multiplies buffered parts per turn and `events()` replays from index 0 — ensure the CF path consumes `events` once (drainable) or accept per-turn growth (bus closes on turn finally).
- **Recovery status not replayed on connect** by `@cloudflare/ai-chat` (only `@cloudflare/think`) — add a `status:'recovering'` to `KuralleAgentState` (which IS broadcast/replayed via `cf_agents_state`) if client-visible recovery is needed.

### 13.4 New test obligations (add to §9)

- `test:recovery_idempotent` (B1) — a tool whose effect-row was written but whose turn was interrupted post-write is NOT re-executed on recovery; plus the post-write/pre-commit window case.
- `test:await_convert` (B2) — `onChatMessage` awaits `convertToModelMessages` (missing await is a fail).
- `test:input_once` (M3) — turn-N user message appears exactly once in model context.
- `test:no_orphan_toolresult` (M4) — long transcript trim never orphans a tool-result.
- `cmd:recovery_progress` (M5, live) — recovery progress counter advances with the writer path.
- `test:tool_parts_persisted` (M11) — turn-1 tool/reasoning parts present in turn-2 `this.messages`.

> Cross-RFC note (CORRECTED after rebasing the worktree onto main @ `f10bf2d`, 0.3.18): the **entire text-hardening backlog H1–H6 + H7a has SHIPPED** (`ba62380`→`f10bf2d`). This RFC was originally drafted against the pre-hardening base, so it must be re-grounded:
> - **S-3 still holds** — `TextDriver` still buffers `draftText` and emits one consolidated `text-delta` after `applyPostTurnPolicies` (`TextDriver.ts:69-72,135-144`). The RFC's core `streaming:'live'` change remains valid and needed.
> - **H1 does NOT dissolve the live-stream tension** (earlier draft claimed it would). H1 shipped as `ctx.outOfBandControl` (default OFF) that only **silos flow-control tools** out of the model's toolset (`resolveTools`, `TextDriver.ts:171-209`); it does not move speaking generation to a separate pass. **H6 deepened the tension**: `applyPostTurnPolicies` now returns a `control`/`confidence` and can block/reroute the text (`:135-139`), so the buffered-fallback (M2) is now the default path for any agent using a confidence/grounding gate.
> - **The new core surface to adopt:** `agent.validate`/`agent.refine` (policy entry-point, mooting part of M2), `ctx.controlModel` (H2), `ctx.outOfBandControl` (H1), the SessionMutex turn-lock + FIFO inbox (H3, supersedes the single-slot input seam in S-5/M3), and the new `{type:'custom', name, data}` `HarnessStreamPart` (`stream.ts:25`) which §4.2/§7.2 must map. Re-ground §4.2/§6.2/§7.2 against the 0.3.18 `TextDriver`/`agentTurn`/`stream` before C1–C8. See `docs/kuralle-hardening-plan.md`, ADR 0003.
