# Twilio Transport Usage Guide

This transport bridges Twilio Media Streams (8kHz G.711 μ-law) to your internal 24kHz agent pipeline.

## When to use it

- Phone-call entry via Twilio Programmable Voice.
- Existing TwiML and call routing in Twilio.
- You need Twilio stream lifecycle handling (`start`, `media`, `mark`, `stop`).

## Protocol notes

- Canonical stream ID is `start.streamSid` (fallback to top-level `streamSid` supported).
- Audio payload is `event.media.payload`.
- Mark payload shape is `mark: { name }`.

## Code blueprint

```ts
import { TwilioAgentServer } from '@kuralle/livekit-plugin-transport-twilio';
import { KuralleVoiceSession } from '@kuralle/livekit-plugin';
import { Runtime } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle/livekit-plugin/gemini';

const runtime = new Runtime({
  agents: [{ id: 'assistant', name: 'Assistant', model: openai('gpt-4o-mini'), prompt: 'Be concise.' }],
  defaultAgentId: 'assistant',
  defaultModel: openai('gpt-4o-mini'),
});

const server = new TwilioAgentServer({ port: 3000 });

server.onCall(async (callId) => {
  const voiceSession = new KuralleVoiceSession({
    runtime,
    stt: new GeminiLiveSTT(),
    tts: new GeminiLiveTTS(),
    greeting: 'Thanks for calling. How can I help?',
  });

  await server.startSession(callId, voiceSession);
});

await server.listen();
```

## Production checklist

- Verify TwiML stream endpoint health and TLS termination.
- Handle `stop`/disconnect as deterministic session teardown.
- Add protocol fixtures for `connected/start/media/mark/stop/clear`.
- Monitor resample and output buffering under call burst load.
