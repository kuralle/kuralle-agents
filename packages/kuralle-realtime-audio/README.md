# @kuralle-agents/realtime-audio

> **⏸️ Paused for now.** Kuralle is hardening **text as the primary primitive**.
> The realtime model code here is kept intact, but the realtime `VoiceDriver` is
> off the framework's headline API (it lives behind `@kuralle-agents/core/runtime`)
> and is not part of the active stability program. For voice today, prefer
> **cascaded voice over text** via [`@kuralle-agents/livekit-plugin`](https://www.npmjs.com/package/@kuralle-agents/livekit-plugin)
> (STT → Kuralle text runtime → TTS). Provider-native speech-to-speech will resume later.

Provider-native realtime audio for Kuralle — speech-to-speech voice agents powered by Gemini Live, OpenAI Realtime, or xAI Grok Realtime, with Kuralle keeping tool, flow, and handoff authority.

## Install

```bash
npm install @kuralle-agents/realtime-audio
```

Peer dependencies:

```bash
npm install @kuralle-agents/core ai zod
```

## What it does

Unlike the cascaded path in `@kuralle-agents/livekit-plugin` (STT → LLM → TTS), provider-native realtime sends raw audio directly to the model and receives audio back in a single connection — lower latency, no transcript round-trip.

- **`VoiceEngine`** — call acceptor. Accepts incoming audio connections and creates per-call `VoiceCallSession` workers that bridge a transport to the chosen provider.
- **`VoiceCallSession`** / **`RealtimeCallWorker`** — per-call lifecycle: connects to the provider, routes tool calls through Kuralle runtime, manages session state.
- **`GeminiLiveSession`** — thin wrapper around `@google/genai` `live.connect()`; manages the WebSocket to Gemini, PCM audio encoding, tool dispatch, and session resumption.
- **`OpenAIRealtimeClient`** — OpenAI Realtime API client.
- **`CloudflareRealtimeAdapter`** — plugs any `RealtimeAudioClient` into Kuralle runtime authority inside a Cloudflare Durable Object.
- **`CloudflareGeminiLiveClient`**, **`CloudflareOpenAIRealtimeClient`**, **`CloudflareXAIGrokRealtimeClient`** — Cloudflare Workers variants.
- **`createGeminiClientFactory`** / **`createOpenAIClientFactory`** — provider client factories.
- **`voiceAgentToRuntimeAgent`** — converts a `VoiceAgentConfig` to a standard Kuralle agent config.

## Usage

```typescript
import { VoiceEngine, createGeminiClientFactory } from '@kuralle-agents/realtime-audio';

const engine = new VoiceEngine({
  agents: [
    {
      id: 'support',
      name: 'Support Agent',
      instructions: 'You are a support agent.',
      voice: 'Charon',
      tools: { /* Kuralle tool definitions */ },
    },
  ],
  defaultAgentId: 'support',
  modelClientFactory: createGeminiClientFactory({
    apiKey: process.env.GOOGLE_API_KEY!,
    model: 'gemini-2.5-flash-preview-native-audio',
  }),
});

// Accept a call from any transport (WebSocket, LiveKit, etc.)
const session = await engine.acceptCall({
  callId: crypto.randomUUID(),
  transport: myTransportSession, // implements TransportSession
});

await session.start();
```

## Related

- [`@kuralle-agents/livekit-plugin`](../kuralle-livekit-plugin) — cascaded STT → LLM → TTS voice path via LiveKit
- [`@kuralle-agents/livekit-plugin-transport-ws`](../kuralle-livekit-plugin-transport-ws) — WebSocket transport for audio connections
- [`@kuralle-agents/core`](../kuralle-core) — agents, flows, runtime
