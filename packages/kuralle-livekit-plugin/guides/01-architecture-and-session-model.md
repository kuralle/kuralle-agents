# Architecture And Session Model

## Purpose

This document explains how the core plugin wires LiveKit voice execution to Kuralle runtime sessions, and how that affects memory and store behavior under concurrent calls.

If you only remember one thing, remember this:

- LiveKit `AgentSession` is your voice orchestration runtime.
- Kuralle `Runtime` session is your conversation state and memory identity.
- Production correctness depends on correctly mapping one call to one Aria runtime session ID.

## Core call path

When a transport package starts a voice session, execution flows through these components:

1. Transport adapter receives network media/messages and exposes `audioInput`, `audioOutput`, `textOutput`.
2. `SessionManager.startSession(adapter, voiceSession)` calls `voiceSession.start(adapter)`.
3. `KuralleVoiceSession.start(...)` creates a LiveKit `voice.AgentSession`.
4. `KuralleVoiceSession` binds Aria runtime session identity to transport identity.
5. LiveKit invokes LLM through `KuralleRuntimeLLMAdapter`.
6. `KuralleRuntimeLLMAdapter` calls `runtime.run({ input, sessionId, userId })` and streams `handle.events`.
7. Aria runtime loads or creates a session in its configured `sessionStore`.
8. Runtime updates messages, working memory, metadata, and emits stream parts.

This means session persistence and memory are still owned by Aria runtime, even though voice turn control is owned by LiveKit.

## Session identity contract

The critical implementation point is the core binding in `KuralleVoiceSession.start(...)`:

- `ariaLLM.setSessionContext({ sessionId: transport.id })`

This makes runtime session identity deterministic for each transport connection or call.

Without this, runtime might use a generated fallback ID and call-level memory isolation can become implicit and brittle.

With this, session behavior is explicit:

- WS call with adapter id `ws-abc` maps to runtime session `ws-abc`.
- Twilio call with call id `call-42` maps to runtime session `call-42`.
- SIP call with id `sip-001` maps to runtime session `sip-001`.

## Store behavior

Aria runtime session storage behavior is independent from transport protocol.

Runtime defaults:

- If `sessionStore` is not provided, runtime uses `MemoryStore`.
- If `sessionStore` is provided (for example Redis or Postgres), runtime persists session state there.

That state includes:

- message history
- working memory
- active/current agent routing state
- metadata and handoff history

The core plugin does not remove this behavior. It uses it.

## Concurrency model

The default concurrency model is safe if these conditions are met:

1. one connection or call gets one unique `transport.id`
2. one active `KuralleVoiceSession` per connection or call
3. transport lifecycle closes session on disconnect or BYE/stop

If these are true, concurrent calls naturally isolate by runtime session ID.

What can still go wrong:

- Reusing the same `transport.id` across active calls.
- Multiplexing multiple callers through one adapter instance.
- Sending overlapping turn requests for one session without queueing policy.

## What happens in `kuralle-hono-server`

The HTTP/WebSocket server package uses runtime sessions explicitly by passing `sessionId` into `runtime.run(...)`.

That is the same logical model as core voice plugin now:

- explicit, stable session ID
- repeated turns reuse the same session identity
- memory and store state remain scoped by that identity

## Design rules for new transport adapters

For any new transport package:

1. transport adapter must have unique `id` per call/session
2. `id` must stay stable for the life of that call/session
3. session close path must be deterministic and idempotent
4. adapter must not mutate shared global state between calls
5. protocol-specific data should never leak into core abstractions

## Code blueprint

Use this structure when adding or reviewing a transport integration:

```ts
const runtime = new Runtime({
  agents,
  defaultAgentId: 'assistant',
  defaultModel: openai('gpt-4o-mini'),
  sessionStore: persistentStore, // Redis/Postgres in production
});

const server = new SomeTransportServer(...);

server.onCall(async (callId, transport) => {
  const voiceSession = new KuralleVoiceSession({
    runtime,
    stt,
    tts,
    greeting: null,
  });

  // Internally binds runtime sessionId = transport.id
  await server.startSession(callId, voiceSession);
});

await server.listen();
```

## Anti-patterns to avoid

- Building runtime per incoming call if you intended shared persistent memory behavior across restarts.
- Hiding session IDs behind random values you cannot correlate in logs.
- Reusing one adapter instance for multiple remote callers.
- Coupling transport protocol payload shape into core plugin classes.

## Logging and observability blueprint

At minimum log these fields at session start and end:

- transport id
- runtime session id (should match transport id)
- remote call id or websocket id
- close reason
- duration

Without this, debugging state bleed or memory loss across concurrent calls is mostly guesswork.
