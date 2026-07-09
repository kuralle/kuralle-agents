# @kuralle-agents/livekit-plugin

Connects Kuralle runtime and flow engine to LiveKit's voice infrastructure via a cascaded STT → LLM → TTS pipeline.

## Install

```bash
npm install @kuralle-agents/livekit-plugin
```

Peer dependencies:

```bash
npm install @livekit/agents @livekit/rtc-node @kuralle-agents/core zod
```

## What it does

**Cascaded voice only.** This package bridges Kuralle to LiveKit using the cascaded path: a speech-to-text model transcribes audio, `KuralleRuntimeLLMAdapter` runs a full Kuralle turn (with flows, tools, and handoffs), and a TTS model synthesizes the response back to audio. Provider-native realtime (Gemini Live, OpenAI Realtime) lives in `@kuralle-agents/realtime-audio`.

- **`KuralleRuntimeLLMAdapter`** — wraps any Kuralle `Runtime` as the LLM step in a LiveKit `VoicePipelineAgent`.
- **`createKuralleSession`** — factory that wires an adapter, STT, TTS, and filler into a ready-to-start session.
- **`KuralleVoiceSession`** — WebSocket-based voice session for the `livekit-plugin-transport-ws` server.
- **`KuralleLivekitSession`** — LiveKit room-based voice session for WebRTC deployments.
- **`SessionManager`** — lifecycle manager for concurrent voice sessions.
- **`FillerCoordinator`** — plays audio fillers while Kuralle tools are executing so callers hear activity.

## Usage

```typescript
import { createKuralleSession, KuralleVoiceSession } from '@kuralle-agents/livekit-plugin';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';
import { WebSocketAgentServer } from '@kuralle-agents/livekit-plugin-transport-ws';
import { createRuntime, defineAgent } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';

const runtime = createRuntime({
  agents: [defineAgent({ id: 'support', model: openai('gpt-4o-mini'), instructions: 'You are a support agent.' })],
  defaultAgentId: 'support',
});

const server = new WebSocketAgentServer({ port: 8080 });

server.onConnection(async (transport) => {
  const session = new KuralleVoiceSession({
    runtime,
    stt: new GeminiLiveSTT(),
    tts: new GeminiLiveTTS(),
    greeting: 'Hello, how can I help?',
  });
  await server.startSession(transport, session);
});

await server.listen();
```

## Subpath exports

| Import path | Contents |
|---|---|
| `@kuralle-agents/livekit-plugin` | Core: sessions, adapter, transport, codecs, metrics, recording |
| `@kuralle-agents/livekit-plugin/gemini` | `GeminiLiveSTT`, `GeminiLiveTTS` |
| `@kuralle-agents/livekit-plugin/recording` | Recording manager and storage adapters |
| `@kuralle-agents/livekit-plugin/utils/resample` | `resample`, `createResampler` |

## Related

- [`@kuralle-agents/livekit-plugin-transport-ws`](../livekit-plugin-transport-ws) — WebSocket server used above
- [`@kuralle-agents/livekit-plugin-transport-http`](../livekit-plugin-transport-http) — HTTP/SSE transport alternative
- [`@kuralle-agents/realtime-audio`](../realtime-audio) — provider-native realtime (Gemini Live, OpenAI Realtime)
- [`@kuralle-agents/core`](../core) — agents, flows, runtime
