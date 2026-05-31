import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { createRuntime, defineAgent } from '@kuralle-agents/core';
import { createKuralleChatRouter } from '@kuralle-agents/hono-server';
import { openai } from '@ai-sdk/openai';

const agent = defineAgent({
  id: 'support',
  instructions: 'You are a helpful support agent.',
  model: openai('gpt-4o-mini'),
});

const runtime = createRuntime({ agents: [agent], defaultAgentId: 'support' });

const app = new Hono();
const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });
app.route('/', createKuralleChatRouter({ runtime, upgradeWebSocket }));

const server = serve({ fetch: app.fetch, port: 3000 });
injectWebSocket(server);
