# Cascaded vs Realtime — Decision Tree

The Kuralle LiveKit plugin exposes **three** ways to bring an authority-driven
agent to a LiveKit `voice.Agent`. They are not interchangeable: each maps a
different provider topology onto LiveKit's STT / LLM / TTS slots.

This guide is the canonical answer to "which one do I use?" and the migration
hint when you find yourself reaching for a wrapper that has been deprecated.

## TL;DR — pick one of these three

| Path | Use when | Latency | Provider tools | Entry point |
|---|---|---|---|---|
| **Cascaded** (STT → LLM → TTS) | You want full text-stream control, custom STT/TTS, cross-provider logging, or third-party voices | Higher (3 hops) | All AI-SDK providers | `KuralleVoiceSession` + `KuralleRuntimeLLMAdapter` |
| **Native realtime** | You want Gemini Live / OpenAI Realtime / xAI with full Kuralle tools, flows, handoffs | Lowest | Provider-native realtime | `createRuntime` + `VoiceCallSession` (`@kuralle-agents/realtime-audio`) |
| **Realtime via direct plugin** | You only want raw provider realtime, no Kuralle tools / flows | Lowest | Provider-native realtime | LiveKit plugin's `RealtimeModel` directly (e.g. `@livekit/agents-plugin-google`) |

If you're not sure: start with **native realtime** for voice agents, and
**cascaded** if you need transcript handling, custom voices, or cross-provider
fanout.

## The decision tree

```
            ┌──────────────────────────────────────┐
            │ Do you need provider-native realtime │
            │      (Gemini Live, OpenAI, xAI)?     │
            └──────────────┬───────────────────────┘
                           │
                ┌──────────┴──────────┐
                │                     │
              YES                    NO
                │                     │
                ▼                     ▼
   ┌──────────────────────┐    ┌──────────────────────┐
   │ Do you need Kuralle │    │ Use cascaded:        │
   │ tools, flows,        │    │ KuralleVoiceSession │
   │ handoffs, extraction?│    │ + KuralleRuntimeLLM     │
   └─────────┬────────────┘    │ Adapter              │
             │                 └──────────────────────┘
       ┌─────┴─────┐
       │           │
      YES          NO
       │           │
       ▼           ▼
┌─────────────┐  ┌──────────────────────────┐
│ createRuntime│  │ Use the LiveKit provider │
│ + VoiceCall │  │ plugin directly. Kuralle │
│ Session     │  │ authority is bypassed.   │
└─────────────┘  └──────────────────────────┘
```

## Path A — Cascaded (STT → LLM → TTS)

```ts
import { KuralleVoiceSession, KuralleRuntimeLLMAdapter } from '@kuralle-agents/livekit-plugin';

const session = new KuralleVoiceSession({
  runtime,
  stt: deepgramStt,
  tts: elevenlabsTts,
  vad: silero,
  prompt: 'You are a helpful assistant.',
});

await session.start(transport);
```

- Drives a LiveKit `voice.AgentSession` directly.
- Speaks `say(text, options)`, generates with `generateReply(options)`.
- Per-turn latency ≈ STT-end → LLM-first-token + TTS-TTFB. Several hundred ms
  is typical with sane providers.
- Implements `VoiceSession` (`{ sessionId, close() }`).

Use this when:
- You need the AI-SDK provider matrix (Anthropic, OpenAI text models, custom).
- You need transcripts on the wire — e.g. live captions or analytics.
- Your TTS or STT vendor doesn't have a realtime provider.
- You need to swap STT/TTS independently.

## Path B — Native realtime (`createRuntime` + `VoiceCallSession`)

```ts
import { createRuntime, defineAgent } from '@kuralle-agents/core';
import { GeminiLiveSession, voiceAgentToRuntimeAgent } from '@kuralle-agents/realtime-audio';
import { WebSocketAgentServer } from '@kuralle-agents/livekit-plugin-transport-ws';

const agent = defineAgent({
  id: 'support',
  instructions: 'You are a helpful support agent on a phone call.',
  model,
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'support',
  voiceMode: true,
});

await wsServer.startNativeSession(adapter, {
  runtime,
  createModelClient: () =>
    new GeminiLiveSession({ gemini: { apiKey, model }, agent: voiceConfig }),
});
```

- `createRuntime` drives prompts, tools, flows, and handoffs via `hostLoop` / `runFlow`.
- `VoiceCallSession` bridges transport PCM to the provider realtime client.
- Per-turn latency is the provider's realtime cap — lowest available.

Use this when:
- You want native realtime audio (no STT/TTS hop) with **full Kuralle
  authority**: tools, flows, handoffs.
- Your provider supports realtime (Gemini Live, OpenAI Realtime, xAI Grok
  Realtime, Phonic).

For LiveKit `AgentSession` + official `RealtimeModel`, wire tools through
`LiveKitSessionRunner` with a runtime-backed adapter (see transport-ws examples).

## Path C — Realtime via the provider plugin directly

```ts
import { google } from '@livekit/agents-plugin-google';

const session = new voice.AgentSession({
  llm: new google.beta.realtime.RealtimeModel({
    model: 'gemini-2.5-flash-native-audio-preview-12-2025',
    instructions: 'You are a helpful assistant.',
  }),
});

await session.start({
  agent: new voice.Agent({
    instructions: '...',
    tools: { /* LiveKit-native tools */ },
  }),
});
```

- Kuralle is **bypassed**. No flows, no handoffs, no Kuralle tool
  outcomes — only LiveKit's `llm.ToolContext`.
- Useful for very simple realtime agents or when the Kuralle runtime is
  intentionally not in the picture.

Avoid this if you already have a `createRuntime()` setup — use Path B.

## Migration: from deprecated facades

`KuralleGeminiRealtimeModel` / `KuralleGeminiRealtimeSession` are removed.
New code should use Path B (`createRuntime` + `VoiceCallSession` or
`startNativeSession`) with the official provider `RealtimeModel` when on LiveKit.

## VoiceSession lifecycle

Path A (`KuralleVoiceSession`) implements `VoiceSession` (`sessionId` + `close()`).
Path B uses `VoiceCallSession` from `@kuralle-agents/realtime-audio`.

`createVoiceSession({ mode: 'cascaded', options })` is cascaded-only in v2.

See `issues/16-livekit-plugin.md` for the rationale on not unifying further.

## Metrics envelope

Both paths emit `VoiceMetric` events through `VoiceMetricsSink`. The envelope
carries an explicit `version` field (currently `VOICE_METRIC_VERSION === 1`)
so sinks can negotiate forward-compat across shape changes:

```ts
interface VoiceMetric {
  version: 1;
  type: 'stt' | 'tts' | 'llm' | 'vad' | 'eou' | 'aria_runtime_ttft' | 'aria_runtime_end';
  sessionId: string;
  speechId?: string;
  timestamp: number;
  data: Record<string, unknown>;
}
```

Adding new optional fields or new `type` discriminants is **not** a version
bump; consumers should ignore unknown discriminants. Removing fields, narrowing
existing fields, or altering semantics is a bump.
