# ADR 0005 — AI-SDK-native `UIMessageStream` as the default web output

**Status:** Accepted (2026-06-05)
**Context:** ADR 0004 (0.4.0 assistant-text lifecycle aligned to AI SDK `UIMessageChunk` shape but still serialized as Kuralle JSON-SSE).
**Related:** ADR 0004 — natural successor; 0.4.0 made text *chunks* native-shaped; 0.5.0 makes the *wire* native.

## Context

After 0.4.0, Kuralle's assistant-text lifecycle (`text-start` / `text-delta{id,delta}` / `text-end` / `text-cancel`) mirrors AI SDK `UIMessageChunk` — but `TurnHandle.toResponseStream('sse')` still emits generic `data: ${JSON.stringify(HarnessStreamPart)}`. Every web consumer had to hand-roll a `HarnessStreamPart` → `UIMessageChunk` bridge. That bridge broke on the 0.4.0 `part.text` → `part.delta` flip and remains a recurring fault line.

C1–C3 shipped the adapter (`harnessToUIMessageStream`, `KuralleUIMessage` / `KuralleDataParts`, `TurnHandle.toUIMessageStreamResponse()`) and made `createKuralleChatRouter`'s `POST /api/chat/sse` default to a native `UIMessageStream`. Raw JSON-SSE is opt-in via `?format=raw`. `createKuralleSseChatRouter` remains the explicit raw-SSE-only router.

## Decision

**As of 0.5.0, the default web/HTTP streaming response is an AI SDK `UIMessageStream`.** Web consumers use `useChat` with zero bridge code. Raw `HarnessStreamPart` JSON-SSE is demoted to `?format=raw` for non-UI consumers (curl, Studio, custom transports).

### 1. Native-first mapping principle

Map to AI SDK native parts wherever the SDK has a primitive; use typed `data-kuralle-*` only for Kuralle orchestration residue.

| Category | Wire |
|----------|------|
| Assistant text | native `text-start` / `text-delta` / `text-end` |
| Tools | native `tool-input-available` / `tool-output-available` |
| Flow/node/control telemetry | `data-kuralle-*` with `transient: true` |
| Interactive, safety, handoff, outcome | `data-kuralle-*` persistent (stable `id`) |

### 2. `HarnessStreamPart` → UIMessage mapping (as-built)

Adapter: `packages/core/src/ai-sdk/uiMessageStream.ts`.

| HarnessStreamPart | UIMessage output | Persist? |
|---|---|---|
| `text-start{id}` | `text-start` | persistent (text) |
| `text-delta{id,delta}` | `text-delta` | persistent (text) |
| `text-end{id}` | `text-end` | persistent (text) |
| `text-cancel{id,reason}` | `text-end` (closes active text part) | n/a |
| `tool-call{toolName,args,toolCallId?}` | `tool-input-available` | persistent |
| `tool-result{toolName,result,toolCallId?}` | `tool-output-available` | persistent |
| `node-enter` / `node-exit` | `data-kuralle-node` `{ event, node }` | **transient** |
| `flow-enter` / `flow-transition` / `flow-end` | `data-kuralle-flow` `{ event, flow?, from?, to?, reason? }` | **transient** |
| `interrupted` / `paused` | `data-kuralle-control` `{ event, reason?, waitingFor? }` | **transient** |
| `handoff` | `data-kuralle-handoff` `{ targetAgent, reason? }` | persistent |
| `interactive` | `data-kuralle-interactive` `{ nodeId, prompt, options }` | persistent (`id: nodeId`) |
| `safety-blocked` / `pipeline-validation-block` | `data-kuralle-safety` `{ kind, moderator?, rationale, userFacingMessage? }` | persistent |
| `conversation-outcome` | `data-kuralle-outcome` `{ outcome }` | persistent |
| `custom{name,data}` | `data-kuralle-custom` `{ name, data }` | **transient** |
| `error` | stream error (thrown) | n/a |
| `done` / `turn-end` | internal framing (not emitted as UI parts) | n/a |

Exported types:

```ts
type KuralleUIMessage = UIMessage<KuralleMetadata, KuralleDataParts>;
// KuralleDataParts keys: kuralle-node, kuralle-flow, kuralle-handoff,
//   kuralle-interactive, kuralle-safety, kuralle-outcome, kuralle-control, kuralle-custom
```

### 3. HTTP surface (`@kuralle-agents/hono-server`)

| Route | Default (0.5.0) | Raw opt-in |
|-------|-----------------|------------|
| `POST /api/chat/sse` | `handle.toUIMessageStreamResponse()` — `useChat`-compatible | `?format=raw` → legacy `HarnessStreamPart` JSON-SSE |
| `POST /api/flow/sse` | `harnessToUIMessageStream(flow parts)` | `?format=raw` |
| `POST /api/chat/sse` via `createKuralleSseChatRouter` | always raw JSON-SSE (unchanged) | n/a |

Inbound: `createKuralleChatRouter` accepts both legacy `{ message, sessionId }` and `useChat`-shaped `{ messages: UIMessage[] }` bodies on the SSE routes.

Convenience: `TurnHandle.toUIMessageStreamResponse({ sessionId? })` wraps `harnessToUIMessageStream(handle.events)` with `createUIMessageStreamResponse`.

### 4. `HarnessStreamPart` stays internal

`HarnessStreamPart` and `toResponseStream('sse'|'ndjson')` are unchanged. They remain the transport-neutral substrate for cascaded voice (LiveKit TTS), messaging adapters, WebSocket widget, and `?format=raw` consumers. `UIMessageStream` is the web/React edge adapter only.

### 5. Versioning

Shipped as **`0.5.0`**, unified across all packages. **Breaking for web consumers** that parsed raw `HarnessStreamPart` JSON from `POST /api/chat/sse` without `?format=raw`. No runtime flag — migration is at the release boundary.

**Consumer migration:**
- Web/React: delete any `HarnessStreamPart` → `UIMessageChunk` bridge; point `useChat` at `/api/chat/sse` (default).
- Raw JSON-SSE consumers: append `?format=raw` to preserve the 0.4.x wire.
- Direct runtime: `handle.toUIMessageStreamResponse()` for HTTP; `handle.events` / `toResponseStream()` for non-UI paths.

## Caveats

1. **SDK version coupling.** The adapter pins native tool-part chunk names (`tool-input-available`, `tool-output-available`) against `ai ^6`. Consumers should pin `ai@^6` and treat AI SDK minor bumps as a compatibility check for tool-part shapes.
2. **`data-kuralle-*` is now a public contract.** Persistent parts appear in `message.parts`; transient parts arrive via `useChat({ onData })` only. Adding or renaming data-part keys is a semver concern for UI consumers.
3. **WebSocket/widget unchanged.** Widget and `/ws/:sessionId` still emit sanitized `HarnessStreamPart` JSON — not `UIMessageStream`. Only the HTTP SSE default flipped.
4. **REQ-9 native-realtime advisory unchanged.** Safety gates on native realtime remain post-hoc; this ADR changes output encoding only.

## Consequences

- **Pro:** `useChat` works with zero bridge — assistant text streams natively; Kuralle flow/safety/interactive events are typed `data-kuralle-*` parts.
- **Pro:** `KuralleUIMessage` gives compile-time-safe `message.parts` and `onData` handlers.
- **Pro:** `HarnessStreamPart` substrate untouched — voice, messaging, raw consumers unaffected when they opt into `?format=raw` or dedicated routers.
- **Con:** Breaking default wire for existing web consumers on `/api/chat/sse` without `?format=raw`.
- **Con:** Two wire formats to document and test (native default + raw opt-in).

## Acceptance

- `POST /api/chat/sse` with a `useChat`-shaped body returns native `text-*` chunks and `data-kuralle-*` parts (offline test in `native-uimessage.test.ts`).
- `POST /api/chat/sse?format=raw` returns legacy `HarnessStreamPart` JSON-SSE byte-compatible with 0.4.x.
- Docs show `useChat` against `createKuralleChatRouter` with no bridge as the recommended web path.
- `HarnessStreamPart`, `toResponseStream`, cascaded voice, and messaging paths unchanged.
