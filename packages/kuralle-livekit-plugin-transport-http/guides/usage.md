# HTTP Transport Usage Guide

This transport is a good fit when you want web-friendly request/response semantics and SSE streaming, without requiring a persistent custom protocol from the client.

## When to use it

- Browser or backend clients that can hold an SSE stream and send JSON POSTs.
- Integrations where network policy blocks custom WebSocket protocols.
- Workflows that treat user input as discrete turns (text or buffered audio).

## Runtime contract

- `GET /session?id=<id>`: opens SSE stream and initializes transport/session if missing.
- `POST /session?id=<id>`: accepts `user_text`, `user_audio`, or `end_session`.
- Text generation is asynchronous; request is acknowledged once queued.

## Code blueprint

```ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createAgentHandler } from '@kuralle/livekit-plugin-transport-http';
import { KuralleVoiceSession } from '@kuralle/livekit-plugin';
import { Runtime } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle/livekit-plugin/gemini';

const app = new Hono();

const runtime = new Runtime({
  agents: [{ id: 'assistant', name: 'Assistant', model: openai('gpt-4o-mini'), prompt: 'Be concise.' }],
  defaultAgentId: 'assistant',
  defaultModel: openai('gpt-4o-mini'),
});

const handler = createAgentHandler({
  agent: () =>
    new KuralleVoiceSession({
      runtime,
      stt: new GeminiLiveSTT(),
      tts: new GeminiLiveTTS(),
      greeting: 'Hello, how can I help?',
    }),
});

app.get('/session', (c) => handler.handleSSE(c.req.raw));
app.post('/session', (c) => handler.handleInput(c.req.raw));

serve({ fetch: app.fetch, port: 3000 });
```

## Production checklist

- Initialize LiveKit logger at process startup.
- Enforce payload size limits on audio POSTs.
- Apply per-session timeout and idle cleanup.
- Emit metrics for queue time, generation failures, and session close reason.
