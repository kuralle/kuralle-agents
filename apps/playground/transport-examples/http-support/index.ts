/**
 * Customer Support Agent over HTTP/SSE
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { KuralleVoiceSession } from '@kuralle-agents/livekit-plugin';
import { openai } from '@ai-sdk/openai';
import { GeminiLiveSTT, GeminiLiveTTS } from '@kuralle-agents/livekit-plugin/gemini';
import { initializeLogger } from '@livekit/agents';
import { createAgentHandler } from '@kuralle-agents/livekit-plugin-transport-http';
import { lookupOrder, getProductInfo, transferToHuman } from '../support-agent/index.js';
import { buildSupportRuntime, supportGreeting } from '../support-agent/index.js';

const app = new Hono();
const PORT = 3000;
initializeLogger({ pretty: true });

const model = openai('gpt-4o-mini');
const runtime = buildSupportRuntime(model);

const handler = createAgentHandler({
  agent: () => new KuralleVoiceSession({
    runtime,
    stt: new GeminiLiveSTT(),
    tts: new GeminiLiveTTS(),
    greeting: supportGreeting,
  }),
});

app.get('/session', (c) => handler.handleSSE(c.req.raw));
app.post('/session', (c) => handler.handleInput(c.req.raw));

serve({ fetch: app.fetch, port: PORT });
console.log(`Customer Support Server (HTTP/SSE) listening on port ${PORT}`);
