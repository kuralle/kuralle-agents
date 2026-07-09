# WebSocket Transport Usage Guide

This transport is the baseline for low-latency, bidirectional streaming in server-hosted agents.

## When to use it

- Full-duplex, near-real-time text/audio interactions.
- Custom client protocol under your control.
- Direct transport control without telephony protocol constraints.

## Runtime contract

- Client messages are parsed from JSON (`configure`, `user_text`, `end_of_audio`) plus binary audio frames.
- Server emits structured JSON events and audio output.
- `generateReply()` returns a speech handle; completion is tracked via handle callbacks.

## Code blueprint

```ts
import { WebSocketAgentServer } from '@kuralle/livekit-plugin-transport-ws';
import { KuralleVoiceSession } from '@kuralle/livekit-plugin';
import { Runtime } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle/livekit-plugin/gemini';

const runtime = new Runtime({
  agents: [{ id: 'assistant', name: 'Assistant', model: openai('gpt-4o-mini'), prompt: 'Be concise.' }],
  defaultAgentId: 'assistant',
  defaultModel: openai('gpt-4o-mini'),
});

const server = new WebSocketAgentServer({ port: 8080, defaultSampleRate: 24000 });

server.onConnection(async (transport) => {
  const voiceSession = new KuralleVoiceSession({
    runtime,
    stt: new GeminiLiveSTT(),
    tts: new GeminiLiveTTS(),
    greeting: 'Hello, how can I help?',
  });

  await server.startSession(transport, voiceSession);
});

await server.listen();
```

## Production checklist

- Validate inbound JSON strictly (type, numeric ranges, encoding enum).
- Bound outgoing audio queue and fail fast on slow consumers.
- Track websocket close codes and correlate with session shutdown.
- Add soak tests for sustained concurrent streaming.
