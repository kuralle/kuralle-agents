# Transport Integration Guide

## Purpose

This document explains how to integrate each transport package with `@kuralle/livekit-plugin` core in a consistent way, so behavior is predictable across WS, HTTP, Twilio, SIP, JsSIP, and SmartPBX.

The core principle is simple:

- Transports handle protocol.
- Core handles voice runtime bridge and session identity.
- Aria runtime handles memory and persistence.

## Integration contract

Any transport package should satisfy this contract:

1. expose one adapter instance per remote session/call
2. provide stable adapter identity (`transport.id`)
3. start one `KuralleVoiceSession` per adapter
4. close both adapter and voice session deterministically
5. propagate protocol stop/close into adapter close

## Shared construction blueprint

```ts
import { Runtime } from '@kuralle-agents/core';
import { KuralleVoiceSession } from '@kuralle/livekit-plugin';
import { openai } from '@ai-sdk/openai';

const runtime = new Runtime({
  agents: [{ id: 'assistant', name: 'Assistant', model: openai('gpt-4o-mini'), prompt: 'Be concise and accurate.' }],
  defaultAgentId: 'assistant',
  defaultModel: openai('gpt-4o-mini'),
  sessionStore: persistentStore, // optional, strongly recommended in production
});

function createVoiceSession() {
  return new KuralleVoiceSession({
    runtime,
    stt,
    tts,
    greeting: null,
  });
}
```

Use `createVoiceSession({ mode: 'cascaded', ... })` per call/connection (cascaded-only in v2). Do not reuse one `KuralleVoiceSession` across concurrent callers.

## WebSocket transport

Package:

- `@kuralle/livekit-plugin-transport-ws`
- guide: `packages/kuralle-livekit-plugin-transport-ws/guides/usage.md`

Recommended flow:

1. accept new websocket
2. create adapter for that socket
3. create `KuralleVoiceSession`
4. start session
5. on socket close, close session and adapter

## HTTP/SSE transport

Package:

- `@kuralle/livekit-plugin-transport-http`
- guide: `packages/kuralle-livekit-plugin-transport-http/guides/usage.md`

Recommended flow:

1. `GET /session?id=...` creates or reuses transport/session
2. `POST /session?id=...` submits text/audio turns
3. maintain one logical session per `id`
4. cleanup idle sessions with timeout policy

For HTTP, the session ID in URL query is the critical key for state continuity.

## Twilio transport

Package:

- `@kuralle/livekit-plugin-transport-twilio`
- guide: `packages/kuralle-livekit-plugin-transport-twilio/guides/usage.md`

Protocol correctness requirements:

- read canonical stream id from `start.streamSid` with fallback
- consume inbound audio from `media.payload`
- send marks as `mark: { name }`

Lifecycle requirements:

- create session only when call stream is started
- teardown on `stop` and websocket close

## SIP RTP transport

Package:

- `@kuralle/livekit-plugin-transport-sip`
- guide: `packages/kuralle-livekit-plugin-transport-sip/guides/usage.md`

Use this for server-side SIP trunking and RTP media only.

Recommended flow:

1. `onCall` gives transport + callId
2. create voice session
3. `startSession(callId, voiceSession)`
4. hangup/close cleans both transport and voice session

## SIP WebSocket/WebRTC transport

Package:

- `@kuralle/livekit-plugin-transport-sip-jssip`
- guide: `packages/kuralle-livekit-plugin-transport-sip-jssip/guides/usage.md`

Use this for SIP over WebSocket and WebRTC endpoint scenarios. Keep it separate from RTP trunk assumptions.

## SmartPBX transport

Package:

- `@kuralle/livekit-plugin-transport-smartpbx`
- guide: `packages/kuralle-livekit-plugin-transport-smartpbx/guides/usage.md`

Treat SmartPBX as a first-class transport package, not ad-hoc app glue:

- adapter owns I/O contract
- app layer owns codec wrappers and deployment wiring
- test adapter behavior in package tests

## Cross-transport implementation blueprint

Use this checklist for every transport:

1. identity:
   - unique adapter id per remote call/session
2. session creation:
   - create `KuralleVoiceSession` when remote call/session is accepted
3. runtime mapping:
   - rely on core mapping `sessionId = transport.id`
4. turn submission:
   - send text/audio into transport input interfaces only
5. close:
   - call `voiceSession.close()` and `transport.close()` on teardown
6. observability:
   - log transport id, runtime session id, protocol ids, and close reason

## What not to do

- Do not patch private members of adapters for lifecycle behavior.
- Do not rely on protocol payload fields not represented in package protocol types.
- Do not share one adapter between calls.
- Do not let one transport implementation import private internals of another.

## Reference blueprint for maintainers

```ts
async function startTransportSession(params: {
  transport: TransportAdapter;
  openSession: (voiceSession: KuralleVoiceSession) => Promise<void>;
}) {
  const voiceSession = new KuralleVoiceSession({
    runtime,
    stt,
    tts,
    greeting: null,
  });

  await params.openSession(voiceSession);

  return async () => {
    await voiceSession.close();
    await params.transport.close();
  };
}
```

This keeps transport bootstrap and teardown behavior explicit and easy to audit.
