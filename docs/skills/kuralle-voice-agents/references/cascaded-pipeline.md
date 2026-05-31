# Cascaded Pipeline (STT → LLM → TTS)

Three separate inference calls per turn. Works with any text LLM — use this when your model doesn't support native audio, or when you need specific STT/TTS providers with carrier-grade quality.

Latency: ~1-2s per turn. Pipeline: user audio → STT → text → Kuralle Runtime → text → TTS → audio back.

## Install

```bash
bun add @kuralle-agents/core @kuralle-agents/livekit-plugin @kuralle-agents/livekit-plugin-transport-ws @livekit/agents @livekit/rtc-node ai zod

# STT/TTS providers (pick one or mix)
bun add @livekit/agents-plugin-deepgram       # Deepgram STT + TTS
bun add @livekit/agents-plugin-cartesia       # Cartesia TTS
```

## Basic setup

```ts
import 'dotenv/config';
import { initializeLogger } from '@livekit/agents';
import { openai } from '@ai-sdk/openai';
import { Runtime } from '@kuralle-agents/core';
import { KuralleVoiceSession, TurnDetector } from '@kuralle-agents/livekit-plugin';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';
import { WebSocketAgentServer } from '@kuralle-agents/livekit-plugin-transport-ws';

initializeLogger({ pretty: true });

const runtime = new Runtime({
  agents: [myAgent],
  defaultAgentId: myAgent.id,
  defaultModel: openai('gpt-4o-mini'),
});

// TurnDetector loads Silero VAD + EOU model — do this once at startup
const detector = new TurnDetector();
await detector.initialize();

const server = new WebSocketAgentServer({ port: 8080 });

server.onConnection(async (transport) => {
  const session = new KuralleVoiceSession({
    runtime,
    stt: new GeminiLiveSTT(),
    tts: new GeminiLiveTTS(),
    vad: detector.vad ?? undefined,
    turnDetection: detector.eouTurnDetector ?? undefined,
    greeting: 'Hello! How can I help you today?',
  });
  await server.startSession(transport, session);
});

await server.listen();
```

## Swap STT/TTS providers

`KuralleVoiceSession` accepts any `@livekit/agents-plugin-*` STT and TTS:

```ts
// Deepgram STT + Cartesia TTS
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as cartesia from '@livekit/agents-plugin-cartesia';

new KuralleVoiceSession({
  runtime,
  stt: new deepgram.STT({ model: 'nova-3', language: 'multi' }),
  tts: new cartesia.TTS({ model: 'sonic-3' }),
  greeting: 'Hello!',
});
```

```ts
// Deepgram STT + Deepgram TTS (simplest, one API key)
import * as deepgram from '@livekit/agents-plugin-deepgram';

new KuralleVoiceSession({
  runtime,
  stt: new deepgram.STT({ model: 'nova-3' }),
  tts: new deepgram.TTS({ model: 'aura-2-thalia-en' }),
  greeting: 'Hello!',
});
```

Costs: Deepgram STT ~$0.003/min, TTS ~$0.008/min.

## Direct provider plugins (recommended for production)

Direct plugins connect to provider APIs without the LiveKit inference gateway, avoiding the gateway's concurrent connection limits (5 on free tier) and reducing latency ~28%.

```bash
bun add @kuralle-agents/core @kuralle-agents/livekit-plugin @kuralle-agents/livekit-plugin-transport-ws @livekit/agents @livekit/agents-plugin-deepgram
```

```ts
import { Runtime } from '@kuralle-agents/core';
import { KuralleRuntimeLLMAdapter } from '@kuralle-agents/livekit-plugin';
import { WebSocketTransportAdapter } from '@kuralle-agents/livekit-plugin-transport-ws';
import { voice } from '@livekit/agents';
import * as deepgram from '@livekit/agents-plugin-deepgram';

const runtime = new Runtime({ agents: [myAgent], defaultAgentId: myAgent.id });

// KuralleRuntimeLLMAdapter wraps Runtime as a LiveKit llm.LLM
// AgentSession calls it with transcribed text → Runtime.stream() → flows/tools/triage → text back to TTS
const ariaLLM = new KuralleRuntimeLLMAdapter({ runtime, sessionId: 'my-session' });

const agentSession = new voice.AgentSession({
  stt: new deepgram.STT({ model: 'nova-3', language: 'multi' }),
  llm: ariaLLM,
  tts: new deepgram.TTS({ model: 'aura-2-thalia-en' }),
  maxToolSteps: 5,
});

// Wire the transport
const adapter = new WebSocketTransportAdapter(ws, { sampleRate: 24000, numChannels: 1 });
agentSession.input.audio = adapter.audioInput;
agentSession.output.audio = adapter.audioOutput;
agentSession.output.transcription = adapter.textOutput;

await agentSession.start({ agent: new voice.Agent({ instructions: 'Respond naturally.' }) });
```

Requires `DEEPGRAM_API_KEY`.

## Over SIP (same agent, different transport)

```ts
import { SIPAgentServer } from '@kuralle-agents/livekit-plugin-transport-sip';

const server = new SIPAgentServer({
  localAddress: '0.0.0.0',
  sipPort: 5060,
  rtpPortStart: 10000,
  codec: 'PCMU',
});

server.onCall(async (transport, callId) => {
  const session = new KuralleVoiceSession({
    runtime,
    stt: new GeminiLiveSTT(),
    tts: new GeminiLiveTTS(),
    greeting: 'Hello! How can I help?',
  });
  await server.startSession(callId, session);
});

await server.listen();
```

Same `myAgent` definition, same Runtime. Only the transport changes.

## KuralleVoiceSession options

| Field | Type | Description |
|-------|------|-------------|
| `runtime` | `Runtime` | Kuralle Runtime with your agents |
| `stt` | `STT plugin` | Any `@livekit/agents-plugin-*` STT |
| `tts` | `TTS plugin` | Any `@livekit/agents-plugin-*` TTS |
| `vad` | `VAD` | Optional — from `TurnDetector.vad` |
| `turnDetection` | `TurnDetector` | Optional — EOU model for better turn boundaries |
| `greeting` | `string` | Agent speaks this immediately on connection |
