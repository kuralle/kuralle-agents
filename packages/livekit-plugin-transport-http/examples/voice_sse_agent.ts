/**
 * Voice agent using HTTP/SSE transport with Kuralle.
 *
 * Audio is sent as base64-encoded PCM in JSON POST bodies (push-to-talk).
 * Agent responses stream back as SSE events (text + base64 audio).
 *
 * Usage:
 *   bun run build
 *   npx tsx examples/voice_sse_agent.ts
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { KuralleVoiceSession } from '@kuralle-agents/livekit-plugin';
import { createRuntime, defineAgent } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';
import { initializeLogger } from '@livekit/agents';

// Relative import since we're in the same package
import { createAgentHandler } from '../src/handler.js';

const app = new Hono();

const assistant = defineAgent({
  id: 'assistant',
  name: 'Voice Assistant',
  model: openai('gpt-4o-mini'),
  instructions: 'You are a voice assistant. Keep responses short.',
});

const runtime = createRuntime({
  agents: [assistant],
  defaultAgentId: 'assistant',
  defaultModel: openai('gpt-4o-mini'),
});

initializeLogger({ pretty: true });

// Create the agent handler
const handler = createAgentHandler({
  agent: () => new KuralleVoiceSession({
    runtime: runtime,
    stt: new GeminiLiveSTT(),
    tts: new GeminiLiveTTS(),
    greeting: 'Hello! How can I help?',
  }),
});

// Mount the handler at /voice endpoint
app.get('/voice', (c) => handler.handleSSE(c.req.raw));
app.post('/voice', (c) => handler.handleInput(c.req.raw));

serve({ fetch: app.fetch, port: 3000 });
console.log('Kuralle voice agent listening on http://0.0.0.0:3000');
