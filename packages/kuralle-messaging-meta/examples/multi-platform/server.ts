/**
 * Multi-Platform Agent Example
 *
 * Demonstrates a single Kuralle Runtime serving:
 * - WhatsApp via /messaging/whatsapp/webhook
 * - Messenger via /messaging/messenger/webhook
 * - Web chat via /api/chat/sse
 *
 * All three channels share the same agents, session store, and conversation flows.
 * A customer on WhatsApp and another on Messenger get identical agent behavior.
 *
 * Usage:
 *   WHATSAPP_ACCESS_TOKEN=... WHATSAPP_APP_SECRET=... WHATSAPP_PHONE_NUMBER_ID=... WHATSAPP_VERIFY_TOKEN=... \
 *   MESSENGER_PAGE_ACCESS_TOKEN=... MESSENGER_APP_SECRET=... MESSENGER_PAGE_ID=... MESSENGER_VERIFY_TOKEN=... \
 *   npx tsx examples/multi-platform/server.ts
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { createRuntime, defineAgent, MemoryStore } from '@kuralle-agents/core';
import { createKuralleChatRouter } from '@kuralle-agents/hono-server';
import { createMessagingRouter } from '@kuralle-agents/messaging';
import { createWhatsAppClient } from '@kuralle-agents/messaging-meta/whatsapp';
import { createMessengerClient } from '@kuralle-agents/messaging-meta/messenger';
import { openai } from '@ai-sdk/openai';

const supportAgent = defineAgent({
  id: 'support',
  name: 'Acme Support',
  model: openai('gpt-4o-mini'),
  instructions: `You are a helpful customer support agent for Acme Corp.
Be concise — messaging platforms have character limits.
WhatsApp: 4096 chars. Messenger: 2000 chars.
Keep responses under 500 characters when possible.`,
});

const runtime = createRuntime({
  agents: [supportAgent],
  defaultAgentId: 'support',
  sessionStore: new MemoryStore(),
});

const whatsapp = createWhatsAppClient({
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
  appSecret: process.env.WHATSAPP_APP_SECRET!,
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN!,
});

const messenger = createMessengerClient({
  pageAccessToken: process.env.MESSENGER_PAGE_ACCESS_TOKEN!,
  appSecret: process.env.MESSENGER_APP_SECRET!,
  pageId: process.env.MESSENGER_PAGE_ID!,
  verifyToken: process.env.MESSENGER_VERIFY_TOKEN!,
});

const app = new Hono();

app.use('/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
}));

const messagingRouter = createMessagingRouter({
  runtime,
  platforms: { whatsapp, messenger },
  onStatus: async (status) => {
    console.log(`[status] ${status.messageId} -> ${status.status}`);
  },
  onError: (error, ctx) => {
    console.error(`[${ctx.platform}] Error:`, error.message);
  },
});

app.route('/messaging', messagingRouter);

const chatRouter = createKuralleChatRouter({ runtime });
app.route('/', chatRouter);

app.get('/health', (c) => c.json({
  status: 'ok',
  platforms: ['whatsapp', 'messenger', 'web'],
  timestamp: new Date().toISOString(),
}));

const port = parseInt(process.env.PORT ?? '3333', 10);

console.log(`
  Multi-platform agent running on port ${port}

  WhatsApp webhook:  http://localhost:${port}/messaging/whatsapp/webhook
  Messenger webhook: http://localhost:${port}/messaging/messenger/webhook
  Web chat (SSE):    http://localhost:${port}/api/chat/sse
  Health check:      http://localhost:${port}/health

  All channels share the same Runtime, agents, and session store.
`);

serve({ fetch: app.fetch, port });
