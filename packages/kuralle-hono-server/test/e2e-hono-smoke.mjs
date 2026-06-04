#!/usr/bin/env node
/**
 * Hono SSE Smoke Test — verifies the transport layer works with
 * all compaction/key-facts/triage changes.
 *
 * Starts a Hono server, sends 5 messages via SSE, checks for
 * text responses, no crashes.
 */
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../apps/playground/hospital-demo/.env') });
// Note: run from repo root with: node packages/kuralle-hono-server/test/e2e-hono-smoke.mjs

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { openai } from '@ai-sdk/openai';
import { tool } from 'ai';
import { z } from 'zod';
import { Runtime } from '@kuralle-agents/core';
import { createKuralleChatRouter } from '../dist/index.js';

const model = openai('gpt-4o-mini');

const triageAgent = {
  id: 'triage', type: 'triage', name: 'Router',
  prompt: 'Silent router.',
  model,
  routes: [
    { agentId: 'sales', description: 'Sales and pricing' },
    { agentId: 'tech', description: 'Technical support' },
  ],
  defaultAgent: 'sales',
};
const salesAgent = {
  id: 'sales', type: 'llm', name: 'Sales',
  prompt: 'You are a sales agent. Keep responses under 2 sentences. If asked about technical issues, use transfer_to_triage.',
  model,
  tools: {
    checkPrice: tool({
      description: 'Check price for a plan',
      inputSchema: z.object({ plan: z.string() }),
      execute: async ({ plan }) => ({ plan, price: '$49/mo' }),
    }),
  },
};
const techAgent = {
  id: 'tech', type: 'llm', name: 'Tech',
  prompt: 'You are a tech support agent. Keep responses under 2 sentences. If asked about pricing, use transfer_to_triage.',
  model,
};

const runtime = new Runtime({
  agents: [triageAgent, salesAgent, techAgent],
  defaultAgentId: 'triage',
  defaultModel: model,
  triageAgentId: 'triage',
  retriagePolicy: 'on-handoff-tool',
  autoCompaction: { enabled: true, maxMessages: 8, summaryModel: model },
});

const app = new Hono();
app.use('/*', cors());
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
app.route('/', createKuralleChatRouter({ runtime, upgradeWebSocket }));

const PORT = 9876;
const server = serve({ fetch: app.fetch, port: PORT });
injectWebSocket(server);

console.log('Hono SSE Smoke Test — port ' + PORT);

async function sendSSE(message, sessionId) {
  const body = sessionId
    ? JSON.stringify({ message, sessionId })
    : JSON.stringify({ message });

  const res = await fetch('http://127.0.0.1:' + PORT + '/api/chat/sse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  let text = '';
  let sid = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === 'text-delta') text += data.delta;
        if (data.type === 'done') sid = data.sessionId;
      } catch {}
    }
  }
  return { text, sessionId: sid };
}

const messages = [
  'Hi, what plans do you have?',
  'Can you check the price for the enterprise plan?',
  'My API is down, can someone help?',
  'What was the plan you mentioned?',
  'Thanks, that is all!',
];

let sessionId = null;
let passed = 0;
let failed = 0;

for (let i = 0; i < messages.length; i++) {
  try {
    const result = await sendSSE(messages[i], sessionId);
    sessionId = result.sessionId ?? sessionId;
    const hasText = result.text.trim().length > 0;
    const status = hasText ? 'PASS' : 'FAIL (empty)';
    if (hasText) passed++; else failed++;
    console.log('[' + (i + 1) + '] ' + status + ' | "' + result.text.slice(0, 80) + '..."');
  } catch (err) {
    failed++;
    console.log('[' + (i + 1) + '] ERROR: ' + err.message);
  }
}

console.log('\nResult: ' + passed + '/' + (passed + failed) + ' passed');
server.close();
process.exit(failed > 0 ? 1 : 0);
