# Kuralle LiveKit Core Guides

This guide set explains how to build and operate a production voice pipeline on top of LiveKit while preserving Kuralle runtime session semantics, working memory, and persistent session store behavior.

This package is the core integration layer. It is not a transport by itself. It provides:

- `KuralleVoiceSession`: transport-native voice session wrapper around `voice.AgentSession`.
- `KuralleRuntimeLLMAdapter`: bridge from LiveKit LLM interface to Kuralle runtime stream execution.
- `SessionManager`: lifecycle coordinator for transport-bound sessions.
- shared transport I/O abstractions used by transport packages.

The transport-specific packages are where network protocol details live. The core package should stay transport-agnostic and enforce stable runtime/session behavior.

## Who should read this

- Engineers implementing new transport adapters.
- Engineers operating WS, HTTP, Twilio, SIP, JsSIP, or SmartPBX pipelines at scale.
- Engineers debugging session memory behavior across concurrent calls.

## Reading order

1. `01-architecture-and-session-model.md`
2. `02-transport-integration-guide.md`
3. `03-production-blueprint.md`
4. `04-deployment-overview.md`
5. `05-deployment-fly-io.md`
6. `06-capacity-and-transport-selection.md`
7. `07-deployment-railway.md`
8. `08-deployment-single-vps.md`
9. `09-deployment-vercel-hybrid.md`
10. `10-local-development-and-testing.md`

### Reading order intent

- `01`: core session architecture and isolation model.
- `02`: transport adapter integration contract.
- `03`: production baseline for runtime/session/store wiring.
- `04`: platform deployment architecture and failure-domain boundaries.
- `05`: Fly.io execution playbook adapted from Pipecat-style deployment flow.
- `06`: capacity planning and transport selection policy for 10/day to 3000/day call profiles.
- `07`: Railway-specific deployment strategy and transport suitability.
- `08`: single VPS production pattern with network/process control emphasis.
- `09`: Vercel hybrid pattern and control-plane/media-plane split guidance.
- `10`: local bootstrap, smoke testing, and pre-push validation workflow.

## Transport package callouts

Use this package as the stable core, and use these packages for protocol edges:

- WebSocket transport: `@kuralle/livekit-plugin-transport-ws`
  - Detailed usage: `packages/kuralle-livekit-plugin-transport-ws/guides/usage.md`
- HTTP/SSE transport: `@kuralle/livekit-plugin-transport-http`
  - Detailed usage: `packages/kuralle-livekit-plugin-transport-http/guides/usage.md`
- Twilio Media Streams transport: `@kuralle/livekit-plugin-transport-twilio`
  - Detailed usage: `packages/kuralle-livekit-plugin-transport-twilio/guides/usage.md`
- SIP RTP transport: `@kuralle/livekit-plugin-transport-sip`
  - Detailed usage: `packages/kuralle-livekit-plugin-transport-sip/guides/usage.md`
- SIP WebSocket/WebRTC transport: `@kuralle/livekit-plugin-transport-sip-jssip`
  - Detailed usage: `packages/kuralle-livekit-plugin-transport-sip-jssip/guides/usage.md`
- SmartPBX transport: `@kuralle/livekit-plugin-transport-smartpbx`
  - Detailed usage: `packages/kuralle-livekit-plugin-transport-smartpbx/guides/usage.md`

## Core decisions this guide codifies

- One transport connection or call must map to one runtime session identity.
- Runtime session identity must be explicit and stable for the life of that call.
- Session persistence is controlled by Kuralle runtime `sessionStore` configuration.
- Transport adapters are protocol boundaries. Core plugin should not encode protocol-specific message semantics.
- Concurrency must isolate calls by session ID and by transport ID.

## Code blueprint preview

```ts
const runtime = new Runtime({
  agents,
  defaultAgentId: 'assistant',
  defaultModel: openai('gpt-4o-mini'),
  sessionStore: new RedisSessionStore({ client, prefix: 'voice-prod' }),
});

server.onCall(async (callId, transport) => {
  const voiceSession = new KuralleVoiceSession({
    runtime,
    stt,
    tts,
    greeting: null,
  });

  // Core now binds runtime session context to transport identity.
  await server.startSession(callId, voiceSession);
});
```

If you keep this contract, you will get deterministic per-call memory isolation with persistent stores and clean concurrency behavior.
