# Runtime Guide

`createRuntime()` orchestrates multi-agent conversations, manages session state, and streams output events.

## Core Responsibilities

- Route messages to the active agent
- Maintain session history and collected state
- Emit stream parts for text, tools, handoffs, and lifecycle events
- Apply guardrails, processors, and stop conditions

## Stream Events

`runtime.run()` returns a `TurnHandle` with an `.events` async iterable of `StreamPart` items.

### Web UI (AI SDK native, 0.5.0+)

For React/web consumers, return a native `UIMessageStream` — `useChat` works with no bridge:

```ts
const handle = runtime.run({ input, sessionId });
return handle.toUIMessageStreamResponse({ sessionId });
```

Kuralle orchestration events map to typed `data-kuralle-*` parts (see `docs/adr/0005-ai-sdk-native-uimessage-default.md`). Import `KuralleUIMessage` for compile-time-safe `message.parts`.

With `@kuralle-agents/hono-server`, `POST /api/chat/sse` defaults to this native wire. Append `?format=raw` for legacy `StreamPart` JSON-SSE.

### Direct `StreamPart` consumption

For CLI scripts, messaging, or custom transports, iterate `handle.events` directly. Every part has `{ channel, type, payload }`; render `text-delta` chunks via `part.payload.delta`.

Common types:
- `text-start`, `text-delta`, `text-end`, `text-cancel`
- `tool-call`, `tool-result`
- `handoff`
- `flow-enter`, `node-enter`, `node-exit`, `flow-transition`, `flow-end`
- `custom` (flow/runtime emitted app events)
- `turn-end`, `done`, `error`
- `knowledge-cache-hit`, `knowledge-cache-miss`, `knowledge-search`, `knowledge-quality-check`, `knowledge-reformulation`

Use `PART_CHANNEL` or the envelope's `channel` field to distinguish client events from privileged internal events.

## Stream Callback (Persistence Defaults)

Use `streamCallback` when sending runtime events to file/webhook/DB/queue sinks.

Default behavior is message-oriented:
- emits terminal events plus configured tool and transition events
- does not emit `text-delta` tokens unless enabled
- attaches final assistant text as `fullText` on terminal events
- if no sink is configured, adapter is a no-op

```ts
import { createFunctionStreamSink, createRuntime, defineAgent } from '@kuralle-agents/core';

const runtime = createRuntime({
  agents: [defineAgent({ id: 'triage', instructions: '...', model })],
  defaultAgentId: 'triage',
  streamCallback: {
    sinks: [createFunctionStreamSink(async payload => writeToDb(payload))],
    eventMode: 'message',
    emitToolEvents: true,
    emitTransitionEvents: true,
    emitTextDeltas: false,
    emitFinalText: true,
  },
});
```

To include token deltas:

```ts
streamCallback: {
  sinks: [...],
  eventMode: 'all',
  emitTextDeltas: true,
}
```

## Session Semantics

- Sessions are keyed by `sessionId` and persisted via a `SessionStore`.
- The runtime tracks `activeAgentId`, `currentAgent`, and handoff history.
- Flow progress is stored in durable run state so specialists can resume SOPs after handoffs.
- `contextManager` can compact history before each turn.

## Prompt Memory Hygiene

To prevent internal runtime state from leaking into the model's context window:
- **Filtering**: Keys like internal event logs are automatically redacted from the prompt.
- **Allowlisting**: Individual agents can specify `promptMemoryAllowlist: string[]` to restrict which working-memory keys they see.

## Durability Hardening

Runtime checkpoints session state automatically on critical events:
- `tool-result`
- `flow-transition`
- handoff state updates (after `activeAgentId` mutation)

For external side effects, tools receive a stable `idempotencyKey` in
`options.experimental_context` so downstream systems can de-duplicate writes.

## Routing & Handoffs

Use `routes`/`agents` for triage without user-visible leaks — routing is derived from shape (a routes-only agent is a silent pure dispatcher; an answering agent folds `transfer_to_agent` into its turn). Set `routing: { model }` to choose the control model.
Use `handoffs: ['billing']` to expose the invisible `transfer_to_agent` tool to specialists.

```ts
const support = defineAgent({
  id: 'support',
  instructions: 'General support',
  model,
  handoffs: ['billing', 'booking'],
});
```

## Runtime Configuration

```ts
const runtime = createRuntime({
  agents,
  defaultAgentId: 'router',
  defaultModel,
  maxSteps: 20,
  maxHandoffs: 10,
  contextManager,
  sessionStore,
  inputProcessors,
  outputProcessors,
  outputProcessorMode: 'stream',
  outputRedaction: [
    { pattern: /\b\d{16}\b/, replacement: '[redacted]' },
  ],
  hooks: {
    onStreamPart: async (ctx, part) => {
      if (part.type === 'error') console.error(part.payload.error);
    },
  },
});
```

## Tracing

Use a trace sink for logging, metrics, and audit trails without polluting prompts.

```ts
const loggingSink: TraceSink = {
  write(span) {
    console.log(JSON.stringify(span));
  },
};

const runtime = createRuntime({
  agents,
  defaultAgentId: 'router',
  tracing: { sinks: [loggingSink] },
});
```

## Abort & Interrupt

`runtime.abortSession(sessionId)` cancels an in-flight turn and emits `interrupted`.
Pass `abortSignal` in `runtime.run({ abortSignal })` to propagate cancellation into model/tool calls.
