/**
 * Text-only chatbot using Hono HTTP server with SSE streaming and Kuralle.
 *
 * Usage:
 *   bun run build
 *   npx tsx examples/text_chat_hono.ts
 *
 * Client:
 *   1. Open SSE: const events = new EventSource('/chat?id=my-session');
 *   2. Send text: fetch('/chat?id=my-session', {
 *        method: 'POST',
 *        headers: { 'Content-Type': 'application/json' },
 *        body: JSON.stringify({ type: 'user_text', text: 'Hello!' }),
 *      });
 */
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { KuralleVoiceSession } from '@kuralle-agents/livekit-plugin';
import { createRuntime, defineAgent } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';
import { initializeLogger } from '@livekit/agents';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';

// Relative import since we're in the same package
import { createAgentHandler } from '../src/handler.js';

const app = new Hono();

const assistant = defineAgent({
  id: 'assistant',
  name: 'Assistant',
  model: openai('gpt-4o-mini'),
  instructions: 'You are a helpful assistant. Be concise and friendly.',
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
    greeting: null,
  }),
});

// Mount the handler at /chat endpoint
app.get('/chat', (c) => handler.handleSSE(c.req.raw));
app.post('/chat', (c) => handler.handleInput(c.req.raw));

serve({ fetch: app.fetch, port: 3000 });
console.log('Kuralle text chatbot listening on http://0.0.0.0:3000');
