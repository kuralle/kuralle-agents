# Production Blueprint

## Goal

Build a transport-native, production-ready voice pipeline that:

- isolates each call to its own runtime session
- preserves per-call memory in store
- supports concurrent calls safely
- provides deterministic lifecycle behavior

## Recommended architecture

Use one shared runtime process and create one voice session per active call.

### Process model

- one app process instance
- one shared `Runtime` object in that process
- one persistent `sessionStore` attached to runtime
- one transport server per protocol surface
- one `KuralleVoiceSession` object per active call/session

### Why this model

- shared runtime gives consistent agent/tool/hook behavior
- persistent session store gives durability and traceability
- per-call session objects provide call isolation and predictable cleanup

## Store strategy

For production, do not rely on default in-memory store.

Use Redis or Postgres-backed session store:

- `@kuralle-agents/redis-store`
- `@kuralle-agents/postgres-store`

This lets you:

- recover state across process restarts
- analyze session histories
- debug memory behavior and handoff chains

## End-to-end blueprint

```ts
import { Runtime } from '@kuralle-agents/core';
import { RedisSessionStore } from '@kuralle-agents/redis-store';
import { KuralleVoiceSession } from '@kuralle/livekit-plugin';
import { TwilioAgentServer } from '@kuralle/livekit-plugin-transport-twilio';
import { openai } from '@ai-sdk/openai';

const runtime = new Runtime({
  agents,
  defaultAgentId: 'assistant',
  defaultModel: openai('gpt-4o-mini'),
  sessionStore: new RedisSessionStore({
    client: redisClient,
    prefix: 'voice-prod',
    sessionTtlSeconds: 3600,
  }),
});

const server = new TwilioAgentServer({ port: 8080 });

server.onCall(async (callId) => {
  const voiceSession = new KuralleVoiceSession({
    runtime,
    stt,
    tts,
    greeting: null,
  });

  // Internally maps runtime sessionId to transport id.
  await server.startSession(callId, voiceSession);
});

await server.listen();
```

## Concurrency and isolation blueprint

For `N` concurrent calls:

- you should have `N` unique transport IDs
- you should have `N` active voice sessions
- runtime store should hold `N` distinct session records

Validation checklist:

1. no two active calls share the same session ID
2. no two active calls share the same adapter object
3. teardown removes active call state from transport/session manager maps

## Session ID design

Use IDs that are:

- unique
- stable for session lifetime
- traceable in logs

Examples:

- `twilio-call-<callSid>`
- `sip-call-<callId>`
- `ws-<uuid>`
- `http-session-<clientProvidedId>`

If the transport has a canonical protocol call identifier, include it.

## Lifecycle blueprint

### Start

1. protocol handshake accepted
2. adapter created with stable id
3. voice session created
4. session started and registered

### Active

1. inbound media/text accepted
2. turn generation happens through Aria runtime stream
3. output audio/text emitted to transport

### Stop

1. protocol stop/close event observed
2. session closed
3. adapter closed
4. active maps cleaned
5. final logs/metrics emitted

## Failure handling blueprint

When model/STT/TTS errors happen:

- emit structured error event
- close session when error is unrecoverable
- always run teardown path once
- do not leave adapter in half-open state

When transport disconnect happens:

- treat as authoritative call end
- close voice session and adapter immediately

## Testing blueprint

Your test plan should include:

1. unit tests in core package
   - LLM adapter forwards explicit `sessionId` and `userId`
   - adapter default session id generation is deterministic pattern
   - abort behavior calls runtime abort
2. transport contract tests
   - protocol parse/serialize fixtures
   - lifecycle teardown on disconnect/stop
3. integration tests
   - end-to-end single call turn
   - concurrent calls with distinct session IDs
4. soak tests
   - long-running concurrent sessions
   - memory growth and queue pressure

## Operational blueprint

Log at session start and end:

- transport id
- runtime session id
- external protocol id (callSid, sip call id, ws client id)
- duration
- close reason

Emit metrics:

- active sessions by transport type
- start failures
- abnormal closes
- average session duration
- turn latency percentiles

## Implementation guardrails

- keep core plugin transport-neutral
- keep protocol logic in transport packages
- avoid private API monkey-patching
- keep session ID mapping explicit and tested

If you follow this blueprint, call concurrency and memory/store behavior stay predictable, and debugging remains practical under production load.
