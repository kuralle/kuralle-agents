---
name: kuralle-voice-agents
description: Build, configure, and debug Kuralle voice agents. Use this skill whenever the user wants to add voice or audio to a Kuralle agent, connect to telephony (SIP, Twilio, WebSocket), use realtime models (Gemini Live, OpenAI Realtime, xAI Grok), set up cascaded STT→LLM→TTS pipelines, deploy voice agents to Fly.io or Cloudflare, test voice sessions offline or live, or write prompts for voice agents. Trigger on any mention of: voice agent, phone call, telephony, WebSocket audio, realtime audio, Gemini Live, OpenAI Realtime, SIP, Twilio, SmartPBX, barge-in, TTS, STT, turn detection, VAD, cascaded pipeline, native audio.
---

# Kuralle Voice Agents

> **Cascaded voice + telephony transports moved.** The `livekit-plugin`, `transport-base`, and `livekit-plugin-transport-*` (ws/http/sip/twilio/smartpbx) packages now live in **[kuralle/kuralle-livekit](https://github.com/kuralle/kuralle-livekit)**. Provider-native realtime (`@kuralle-agents/realtime-audio`) stays in the main repo. When this skill refers to cascaded/telephony packages, install them from that repo.

Use this skill when adding audio to any Kuralle agent — from a simple WebSocket voice demo to a production SIP call center.

## Read this first

- **Two pipelines exist.** Choose based on your model and latency requirements.
- **The recommended path is `startNativeSession()`** with an official LiveKit provider plugin. Provider owns audio; Kuralle owns flows, tools, hooks, and persistence.
- **All agent types work in voice.** conversational agent, flow agent, routing agent — same config as text.
- **Switching providers = one import change.** The Kuralle side never changes.
- **Voice extraction requires `extractionModel`** on the authority. Don't skip it.

## Choose your pipeline

| Pipeline | Latency | Use when |
|----------|---------|----------|
| **Native audio** (recommended) | ~200ms | Model supports realtime audio (Gemini, OpenAI, xAI) |
| **Cascaded** (STT → LLM → TTS) | ~1-2s | Text-only LLM, or need specific STT/TTS providers |

## Native audio — recommended path

Uses `startNativeSession()` from `@kuralle-agents/livekit-plugin`. The official LiveKit provider plugin owns the audio session; Kuralle authority handles tools, flows, hooks, and session persistence.

```ts
import { Runtime } from '@kuralle-agents/core';
import { startNativeSession } from '@kuralle-agents/livekit-plugin';
import { WebSocketAgentServer } from '@kuralle-agents/livekit-plugin-transport-ws';
import * as google from '@livekit/agents-plugin-google';
import { initializeLogger } from '@livekit/agents';

initializeLogger({ pretty: true });

const runtime = new Runtime({ agents: [myAgent], defaultAgentId: myAgent.id });
const model = new google.beta.realtime.RealtimeModel({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY!,
  voice: 'Kore',
});
const server = new WebSocketAgentServer({ port: 8080, autoSendSessionStarted: false });

server.onConnection(async (adapter) => {
  const binding = await startNativeSession({
    authority: runtime.authority,
    agentId: myAgent.id,
    sessionId: adapter.id,
    modelPolicy: { provider: 'google', preferUpdateAgentForReconfigure: true },
  });
  const session = await server.startRealtimeSession(adapter, {
    model,
    agent: binding.agent,
    maxToolSteps: 5,
    onSessionEnd: (reason) => void binding.controller.detach(reason),
  });
  binding.controller.attach(session);
});
await server.listen();
```

### Switch provider — change one import

```ts
// OpenAI
import * as openai from '@livekit/agents-plugin-openai';
const model = new openai.realtime.RealtimeModel({ apiKey, voice: 'alloy' });
// modelPolicy: { provider: 'openai', supportsInstructionUpdate: true }

// xAI Grok
import * as xai from '@livekit/agents-plugin-xai';
const model = new xai.realtime.RealtimeModel({ apiKey, voice: 'Cora' });
// modelPolicy: { provider: 'xai', preferUpdateAgentForReconfigure: true }
```

No Kuralle code changes. See `references/native-audio-pipeline.md` for full examples including flows, hooks, persistence, and shutdown.

### Provider support matrix

| Provider | Plugin | Model policy | Flows/handoffs |
|----------|--------|-------------|----------------|
| Gemini 2.5 Flash | `@livekit/agents-plugin-google` | `preferUpdateAgentForReconfigure: true` | Full support |
| Gemini 3.1 Flash | `@livekit/agents-plugin-google` | — | **Blocked** (LiveKit agents-js#1229 pending) |
| OpenAI Realtime | `@livekit/agents-plugin-openai` | `supportsInstructionUpdate: true` | Full support |
| xAI Grok | `@livekit/agents-plugin-xai` | `preferUpdateAgentForReconfigure: true` | Full support |

Use `gemini-2.5-flash-native-audio-preview-12-2025` for Gemini. Gemini 3.1 Flash breaks flow/handoff reconfiguration until the upstream LiveKit PR merges.

## Cascaded pipeline

Three separate inference calls per turn. Useful when you need a text-only LLM or specific STT/TTS providers.

```ts
import { Runtime } from '@kuralle-agents/core';
import { KuralleVoiceSession, TurnDetector } from '@kuralle-agents/livekit-plugin';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';
import { WebSocketAgentServer } from '@kuralle-agents/livekit-plugin-transport-ws';

const runtime = new Runtime({ agents: [myAgent], defaultAgentId: myAgent.id });
const detector = new TurnDetector();
await detector.initialize(); // loads Silero VAD + EOU model once

const server = new WebSocketAgentServer({ port: 8080 });
server.onConnection(async (transport) => {
  const session = new KuralleVoiceSession({
    runtime,
    stt: new GeminiLiveSTT(),
    tts: new GeminiLiveTTS(),
    vad: detector.vad ?? undefined,
    turnDetection: detector.eouTurnDetector ?? undefined,
    greeting: 'Hello! How can I help?',
  });
  await server.startSession(transport, session);
});
await server.listen();
```

`KuralleVoiceSession` accepts any `@livekit/agents-plugin-*` STT/TTS. Swap providers by changing `stt` / `tts` arguments. See `references/cascaded-pipeline.md` for Deepgram, Cartesia, and SIP variants.

## Transports

Every transport is a drop-in replacement — the agent and runtime code stays identical.

| Transport | Package | Wire format | Use case |
|-----------|---------|-------------|----------|
| **WebSocket** | `@kuralle-agents/livekit-plugin-transport-ws` | Int16 PCM binary | Browser/SDK clients |
| **SIP/RTP** | `@kuralle-agents/livekit-plugin-transport-sip` | G.711 via RTP | 3CX, FreePBX, SIP trunks |
| **Twilio** | `@kuralle-agents/livekit-plugin-transport-twilio` | G.711 u-law + JSON | Twilio Voice |
| **SmartPBX** | `@kuralle-agents/livekit-plugin-transport-smartpbx` | PCM/G.711 + JSON | SmartPBX telephony |
| **SIP/WebSocket** | `@kuralle-agents/livekit-plugin-transport-sip-jssip` | WebRTC via JsSIP | Browser SIP clients |
| **HTTP/SSE** | `@kuralle-agents/livekit-plugin-transport-http` | Upload + SSE | HTTP-based voice |

See `references/transports.md` for all transport packages including SIP setup and codec chain details.

## Navigation

- `references/native-audio-pipeline.md` — full examples: flows, hooks, persistence, handoffs, shutdown
- `references/cascaded-pipeline.md` — KuralleVoiceSession, TurnDetector, direct provider plugins
- `references/transports.md` — all transport packages, SIP server setup, SIPTestClient
- `references/voice-testing.md` — FakeRealtimeAudioClient, TestSession, audio fixture pacing
- `references/voice-prompt-rules.md` — prompt patterns specific to voice (short turns, single ask, etc.)

Rules:
- `rules/voice-prompt-rules.md` — voice prompting non-negotiables
- `rules/extraction-model-required.md` — why extractionModel must be set in voice

## Non-negotiables

- Flow agents in voice require the same `startNativeSession()` setup — no special voice-only config.
- Always use `extractionModel` on the authority when using extraction nodes in voice. Without it, the model can hallucinate extracted fields.
- Audio must be paced at real-time speed in tests (`sendAudioFramesPaced(data, 960, 20)`). Static audio dumps don't trigger Gemini's VAD.
- For SIP/telephony with OpenAI, tune VAD: `{ threshold: 0.3, silence_duration_ms: 500, prefix_padding_ms: 300 }`.
- Use `session.shutdown({ drain: true })` for graceful cleanup — lets the agent finish speaking before disconnect.
