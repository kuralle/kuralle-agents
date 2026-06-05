# RFC: AI-SDK-native output — `toUIMessageStream()` adapter + typed `data-*` parts

**Category:** Architectural Change (additive, non-breaking)
**Author:** octalpixel
**Date:** 2026-06-05
**Status:** Draft
**Reviewers:** TBD
**Related:**
- `docs/rfc-streaming-by-default.md` + `docs/adr/0004-streaming-by-default.md` — the 0.4.0 lifecycle that aligned the *text* shape to AI SDK `UIMessageChunk`. This RFC is its natural successor (align the *whole* stream).
- Studio `RFC-007` (separate repo) — the `SSEChatTransport` bridge bugs that motivated this.
- API verified against `ai@6.0.0-beta.128` (Context7 `/vercel/ai`, 2026-06-05). `ai ^6.0.0` is already a direct dependency of `@kuralle-agents/core`.

---

## 1. Problem Statement

Kuralle uses the AI SDK **internally** (`streamText().fullStream` in `TextDriver.ts:64`) but exposes its **own** stream taxonomy over its **own** wire, so it is **not AI-SDK-native** to consumers:

1. **Own taxonomy.** `HarnessStreamPart` (`packages/kuralle-core/src/types/stream.ts:9-37`) is a hand-rolled ~23-variant union: the text lifecycle (`text-start`/`text-delta{id,delta}`/`text-end`/`text-cancel`) **plus** `tool-call`/`tool-result`, `flow-enter`/`flow-end`, `node-enter`/`node-exit`, `flow-transition`, `handoff`, `interrupted`/`paused`, `conversation-outcome`, `interactive`, `turn-end`, `pipeline-validation-block`, `safety-blocked`, `error`, `custom`, `done`.
2. **Own wire.** `TurnHandle.toResponseStream('sse')` emits generic `data: ${JSON.stringify(part)}` (`events/TurnHandle.ts:91`) — **not** the AI SDK UI Message Stream protocol.
3. **Therefore every web consumer needs a hand-written bridge** from `HarnessStreamPart` → AI SDK `UIMessageChunk`. This bridge is the recurring fault line:
   - `nextjs-chatbot/lib/kuralle/stream-bridge.ts` (kuralle-starters) — bridges by hand; broke on the 0.4.0 `part.text`→`part.delta` flip.
   - Studio `SSEChatTransport` (RFC-007) — the same class of `text`-vs-`delta`/lifecycle bugs.
   - `kuralle-cf-agent/src/StreamAdapter.ts` — yet another hand-rolled SSE mapping.

The 0.4.0 release made the **text-delta shape** mirror `UIMessageChunk` (`{id, delta}`) — a step in the native direction — but the stream is still serialized as Kuralle's protocol and the other ~18 event types are not AI SDK primitives. **We mirror `UIMessageChunk`; we do not emit a `UIMessageStream`.** Consumers still pay the bridge tax and inherit its breakage.

**Success criteria:**
- A web consumer can drive a Kuralle agent with `useChat` (AI SDK) and **zero bridge code** — assistant text streams natively and Kuralle flow/safety events arrive as typed `data-*` parts.
- `nextjs-chatbot/lib/kuralle/stream-bridge.ts` is **deleted**; the template uses `useChat` directly.
- Existing consumers (voice/cascaded, messaging, the raw JSON-SSE wire) are **unchanged** — this is additive.
- The adapter is type-safe: a single exported `KuralleUIMessage = UIMessage<Metadata, KuralleDataParts>` gives consumers typed `message.parts`.

## 2. Background

### 2.1 The AI SDK v5/v6 surface (verified)

- **Server builder:** `createUIMessageStream({ originalMessages?, generateId?, execute({ writer }) {…}, onFinish? })` + `createUIMessageStreamResponse({ stream })` / `pipeUIMessageStreamToResponse(...)`.
- **Custom data parts:** `writer.write({ type: 'data-<name>', id?, data, transient? })`. `id` ⇒ reconciliation (same id updates the existing part). `transient: true` ⇒ delivered to the client via `useChat({ onData })` but **not** persisted into `message.parts`.
- **Merging an LLM stream:** `writer.merge(result.toUIMessageStream())`, or directly `streamText(...).toUIMessageStreamResponse()`.
- **Native part types:** `text` (`text-start`/`text-delta`/`text-end`), `reasoning`, `source`, tool parts (`tool-input-*` / `tool-output-*`), `file`, and `data-*`.
- **Client:** `useChat({ onData: ({ type, data }) => … })`; persistent data parts appear in `message.parts`.
- **Type safety:** define `type MyUIMessage = UIMessage<MyMetadata, MyDataParts>` and `createUIMessageStream<MyUIMessage>(...)`.
- **Message types:** model-facing `ModelMessage` (was `CoreMessage` in v4), UI-facing `UIMessage`; `convertToModelMessages(uiMessages)` (was `convertToCoreMessages`). The v4 `StreamData` / `createDataStreamResponse` / `toDataStreamResponse` family is **removed** in v5.

### 2.2 Why keep `HarnessStreamPart` at all?

Kuralle is multi-transport. `HarnessStreamPart` is consumed by paths that are **not** `useChat`:
- **Cascaded voice** — `KuralleRuntimeLLMAdapter` consumes `text-delta.delta` for LiveKit TTS.
- **Messaging** (WhatsApp), the **widget**, the **raw JSON-SSE/ndjson** wire, **cf-agent**.

A `UIMessageStream` is a web/React UI representation; it is the wrong abstraction for TTS chunking or a WhatsApp adapter. So `HarnessStreamPart` stays as the **transport-neutral internal model**, and `toUIMessageStream()` is the **edge adapter for the web/AI-SDK path** — which is exactly the AI SDK's own recommended shape (produce your stream, adapt to UI at the edge).

## 3. Strict Requirements

- **REQ-1:** Add a pure adapter `harnessToUIMessageStream(source: AsyncIterable<HarnessStreamPart>, opts): UIMessageStream` (and a `TurnHandle.toUIMessageStreamResponse(opts?)` convenience) that maps the Kuralle stream to an AI SDK `UIMessageStream`. **Additive** — `toResponseStream('sse'|'ndjson')` is unchanged and retained.
- **REQ-2:** Assistant text maps to native text parts: `text-start{id}`→text-start, `text-delta{id,delta}`→text-delta, `text-end{id}`→text-end, `text-cancel{id}`→close/abort the active text part. No bridge needed downstream.
- **REQ-3:** Tool events map to native AI SDK tool parts (`tool-call`→tool-input-available, `tool-result`→tool-output-available). Exact v6 tool-part chunk names are pinned at implementation against the installed `ai` version (see §12 Q2).
- **REQ-4:** Kuralle-specific events map to **typed `data-*` parts** under a `data-kuralle-*` namespace (see §4.2 table). Telemetry-ish events (`node-enter`, `node-exit`, `flow-transition`, `flow-enter`, `flow-end`, `interrupted`, `paused`) are `transient: true` (observable via `onData`, not persisted). Conversation-shaping events (`interactive`, `handoff`, `safety-blocked`, `pipeline-validation-block`, `conversation-outcome`) are **persistent** (appear in `message.parts`) with stable `id`s.
- **REQ-5:** Export a typed `KuralleUIMessage = UIMessage<KuralleMetadata, KuralleDataParts>` so consumers get compile-time-safe `message.parts` and `onData`.
- **REQ-6:** `error`→stream error; `done`→stream finish; `turn-end` is internal framing (not emitted as a UI part, or a transient marker).
- **REQ-7:** No change to the voice/cascaded path, messaging, or the raw JSON-SSE wire. The cascaded adapter keeps consuming `HarnessStreamPart` directly.
- **REQ-8:** The hono-server `createAriaChatRouter` gains an opt-in UI-message mode (e.g. `?format=ui` or a dedicated route) returning `createUIMessageStreamResponse`, so a `useChat` client works end-to-end with no bridge.
- **REQ-9:** `convertToModelMessages` is used where the server accepts `UIMessage[]` input from `useChat` (the inbound direction), replacing any bespoke message coercion.
- **REQ-10:** No new runtime dependency — `ai ^6` is already a `core` dependency. The adapter lives in `core` (or a thin `@kuralle-agents/ai-sdk` if we want to keep `core` UI-agnostic — see §12 Q1).

## 4. Interface Specification

### 4.1 Core adapter
```ts
// packages/kuralle-core/src/ai-sdk/uiMessageStream.ts (new)
import type { UIMessage } from 'ai';
import type { HarnessStreamPart } from '../types/stream.js';

export type KuralleMetadata = { sessionId?: string };
export type KuralleDataParts = {
  'kuralle-node': { event: 'enter' | 'exit'; node: string };
  'kuralle-flow': { event: 'enter' | 'transition' | 'end'; flow?: string; from?: string; to?: string; reason?: string };
  'kuralle-handoff': { targetAgent: string; reason?: string };
  'kuralle-interactive': { nodeId: string; prompt: string; options: { label: string; value: string }[] };
  'kuralle-safety': { kind: 'safety-blocked' | 'pipeline-validation-block'; moderator?: string; rationale: string; userFacingMessage?: string };
  'kuralle-outcome': { /* ConversationOutcome shape */ };
  'kuralle-control': { event: 'interrupted' | 'paused'; reason?: string; waitingFor?: string };
};
export type KuralleUIMessage = UIMessage<KuralleMetadata, KuralleDataParts>;

export function harnessToUIMessageStream(
  source: AsyncIterable<HarnessStreamPart>,
  opts?: { sessionId?: string },
): ReadableStream; // a UIMessageStream
```

### 4.2 `HarnessStreamPart` → UIMessage part mapping (REQ-2/3/4)

| HarnessStreamPart | UIMessage output | Persist? |
|---|---|---|
| `text-start{id}` / `text-delta{id,delta}` / `text-end{id}` | native `text-start`/`text-delta`/`text-end` | persistent (text) |
| `text-cancel{id,reason}` | abort/close active text part | n/a |
| `tool-call{toolName,args,toolCallId}` | native tool-input-available | persistent |
| `tool-result{toolName,result,toolCallId}` | native tool-output-available | persistent |
| `node-enter`/`node-exit` | `data-kuralle-node` | **transient** |
| `flow-enter`/`flow-transition`/`flow-end` | `data-kuralle-flow` | **transient** |
| `interrupted`/`paused` | `data-kuralle-control` | **transient** |
| `handoff` | `data-kuralle-handoff` | persistent |
| `interactive` | `data-kuralle-interactive` | persistent |
| `safety-blocked`/`pipeline-validation-block` | `data-kuralle-safety` | persistent |
| `conversation-outcome` | `data-kuralle-outcome` | persistent |
| `custom{name,data}` | `data-kuralle-custom` (passthrough) | transient |
| `error` | stream error | n/a |
| `done` | stream finish (`onFinish`) | n/a |
| `turn-end` | internal framing (not a UI part) | n/a |

### 4.3 hono-server (REQ-8)
```ts
// createAriaChatRouter gains a UI-message mode
// POST /api/chat?format=ui  (or a dedicated /api/chat/ui route)
//   inbound: UIMessage[] from useChat  -> convertToModelMessages(...)
//   outbound: createUIMessageStreamResponse({ stream: harnessToUIMessageStream(handle.events, { sessionId }) })
```

## 5. Architecture & Dependencies

**Created:** `packages/kuralle-core/src/ai-sdk/uiMessageStream.ts` (adapter + `KuralleUIMessage` types); a `TurnHandle.toUIMessageStreamResponse()` convenience.
**Modified:** `@kuralle-agents/hono-server` `createAriaChatRouter` (opt-in UI mode, REQ-8); `kuralle-starters/nextjs-chatbot` **deletes** `lib/kuralle/stream-bridge.ts` and uses `useChat` directly (the proof consumer).
**Unchanged:** `HarnessStreamPart`, `toResponseStream`, the cascaded voice adapter, messaging, the widget.
**Dependencies:** none new (`ai ^6` already in `core`).

## 6. Pseudocode
```
FUNCTION harnessToUIMessageStream(source, opts):
  RETURN createUIMessageStream({
    execute({ writer }):
      FOR await part IN source:
        SWITCH part.type:
          'text-start'|'text-delta'|'text-end': writer.write(<native text chunk>)
          'text-cancel':  close active text part
          'tool-call':    writer.write(<native tool-input-available>)
          'tool-result':  writer.write(<native tool-output-available>)
          'node-enter'|'node-exit':              writer.write({type:'data-kuralle-node', data, transient:true})
          'flow-enter'|'flow-transition'|'flow-end': writer.write({type:'data-kuralle-flow', data, transient:true})
          'handoff':      writer.write({type:'data-kuralle-handoff', id, data})
          'interactive':  writer.write({type:'data-kuralle-interactive', id: part.nodeId, data})
          'safety-blocked'|'pipeline-validation-block': writer.write({type:'data-kuralle-safety', id, data})
          'conversation-outcome': writer.write({type:'data-kuralle-outcome', id, data})
          'interrupted'|'paused': writer.write({type:'data-kuralle-control', data, transient:true})
          'custom':       writer.write({type:'data-kuralle-custom', data, transient:true})
          'error':        throw  // surfaces as stream error
          'done'|'turn-end': // framing only
  })
```

## 7. Incremental Task Breakdown

| ID | Chunk | Files | Acceptance |
|----|-------|-------|-----------|
| C1 | `KuralleDataParts` + `KuralleUIMessage` types | `core/src/ai-sdk/uiMessageStream.ts` | types compile; exported from `core` index |
| C2 | `harnessToUIMessageStream` adapter (text + data-* + error/done) | same | unit test: a fixed `HarnessStreamPart[]` → expected UIMessageStream chunks (text native, events as `data-kuralle-*`, transient flags correct) |
| C3 | Tool-part mapping (pin exact v6 chunk names) | same | unit test: tool-call/result → native tool parts |
| C4 | `TurnHandle.toUIMessageStreamResponse()` convenience | `core/src/events/TurnHandle.ts` | returns a `Response` (createUIMessageStreamResponse) |
| C5 | hono-server UI mode + `convertToModelMessages` inbound | `hono-server` | a `useChat` POST round-trips end-to-end (offline test) |
| C6 | Proof consumer: delete `stream-bridge.ts`, wire `useChat` | kuralle-starters `nextjs-chatbot` | the template renders streamed text + a `data-kuralle-*` part with **no bridge**; `verify-templates.sh` green |
| C7 | Docs + ADR 0005 | `apps/docs`, README, `docs/adr/0005-*.md` | documents the native path + the `data-kuralle-*` taxonomy |

## 8. Validation & Testing
- **Unit:** `uiMessageStream.test` — drive the adapter with a fixed `HarnessStreamPart[]` (text lifecycle + each event) and assert the emitted UIMessageStream chunks (native text; `data-kuralle-*` types; `transient` on telemetry; persistent ids on interactive/safety/handoff).
- **Integration:** an offline `useChat`-shaped consumer over the hono UI route asserts text renders and a `data-kuralle-safety` part is surfaced via `onData`.
- **Consumer proof (C6):** `nextjs-chatbot` with `stream-bridge.ts` deleted still streams correctly.
- **Regression:** the raw `toResponseStream` wire + the cascaded voice path are untouched (existing suites green).

## 9. Security
- `safety-blocked`/`pipeline-validation-block` become **persistent** `data-kuralle-safety` parts so a UI can render the block reason — same information as today, now first-class. The 0.4.x gate semantics (text never emits blocked content on text/cascaded; advisory on native realtime) are unchanged — this RFC only changes the *output encoding*, not the gating.
- `transient` events (node/flow telemetry) are not persisted to history, avoiding leaking internal routing into stored messages.

## 10. Rollback
Purely additive — the new adapter + opt-in hono mode can be removed without touching `HarnessStreamPart`, `toResponseStream`, or any existing consumer. No version-gate; ship in a minor (`0.5.0`) as a new capability (consider deprecating — not removing — the per-consumer bridge pattern in docs).

## 11. Open Questions

- **Q1 — Where does the adapter live?** `@kuralle-agents/core` (since `ai ^6` is already a dep) vs a new thin `@kuralle-agents/ai-sdk` to keep `core` UI-framework-agnostic. **Proposal:** start in `core/src/ai-sdk/` (no new package; `ai` already present); extract later if `core` should shed UI concerns.
- **Q2 — Exact v6 tool-part chunk names.** v6 uses `tool-input-start`/`tool-input-delta`/`tool-input-available`/`tool-output-available`. Kuralle currently emits a single `tool-call` (full args) + `tool-result`, so map `tool-call`→`tool-input-available` and `tool-result`→`tool-output-available`. Pin exact shapes against the installed `ai` version at C3 (the SDK churns here).
- **Q3 — Deprecate the raw JSON-SSE wire?** No — keep it for non-UI consumers (curl, debugging, custom transports). The UIMessageStream is additive, not a replacement.
- **Q4 — Versioning.** Additive ⇒ `0.5.0` minor (new capability), not a patch. No breaking change to 0.4.x consumers.
- **Q5 — Voice transcripts to UI?** Out of scope: the native-realtime voice path stays on `HarnessStreamPart`/audio; a UIMessageStream for voice transcripts is a separate future RFC.
