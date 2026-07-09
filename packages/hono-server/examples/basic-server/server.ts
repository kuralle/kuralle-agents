import { config as loadEnv } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { createRuntime, defineAgent } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';
import { createKuralleChatRouter } from '../../src/index.js';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '.env');
loadEnv({ path: envPath });

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY is required');
  process.exit(1);
}

const supportAgent = defineAgent({
  id: 'support',
  name: 'Support Agent',
  description: 'General support and FAQs',
  instructions: `You are a helpful customer support agent.
- Be concise and friendly.
- Ask clarifying questions when needed.
- If you do not know, say so.
`,
  model: openai('gpt-4o-mini'),
});

const runtime = createRuntime({
  agents: [supportAgent],
  defaultAgentId: 'support',
});

const app = new Hono();
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

app.route('/', createKuralleChatRouter({ runtime, upgradeWebSocket }));

const port = Number(process.env.PORT ?? 3333);
const server = serve({ fetch: app.fetch, port });

injectWebSocket(server);

console.log(`Kuralle Hono server running at http://localhost:${port}`);
console.log(`WebSocket available at ws://localhost:${port}/ws/:sessionId`);
