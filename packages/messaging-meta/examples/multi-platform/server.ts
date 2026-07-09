/**
 * Multi-Platform Agent Example (WhatsApp + Instagram + Web)
 *
 * One Kuralle Runtime and one flow/agent set, with channel differences isolated in
 * `engagement({ policies: [whatsappPolicy, webPolicy, instagramPolicy] })`.
 *
 * - WhatsApp + Instagram: `createMessagingRouter` + Meta webhooks
 * - Web: `createKuralleChatRouter` (SSE) on the same runtime
 *
 * Live Meta/OpenAI calls require env vars (see README). Typecheck/build do not.
 *
 * Usage (from `packages/messaging-meta`):
 *   npx tsx examples/multi-platform/server.ts
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { z } from 'zod';
import { openai } from '@ai-sdk/openai';
import {
  collect,
  createRuntime,
  decide,
  defineAgent,
  defineFlow,
  MemoryStore,
  reply,
} from '@kuralle-agents/core';
import { createKuralleChatRouter } from '@kuralle-agents/hono-server';
import { createMessagingRouter, InMemoryWindowStore } from '@kuralle-agents/messaging';
import {
  engagement,
  sessionConsentStore,
  sessionOwnershipStore,
  webPolicy,
  whatsappPolicy,
  instagramPolicy,
  withChoices,
  aiTemplateSelector,
} from '@kuralle-agents/engagement';
import { createWhatsAppClient } from '@kuralle-agents/messaging-meta/whatsapp';
import { createInstagramClient } from '@kuralle-agents/messaging-meta/instagram';

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Set Meta/WhatsApp/Instagram tokens (see README) or run offline tests instead.`,
    );
  }
  return value;
}

const TriageSchema = z.object({ choice: z.string() });

const endNode = reply({
  id: 'done',
  instructions: 'Thanks — we received your selection.',
  next: () => ({ end: 'done' }),
});

const triageNode = withChoices(
  decide({
    id: 'triage',
    instructions: 'How can we help?',
    schema: TriageSchema,
    decide: (sel) => {
      if (sel === 'billing') {
        return collect({
          id: 'billing',
          schema: z.object({ issue: z.string() }),
          onComplete: () => endNode,
        });
      }
      if (sel === 'agent') {
        return { escalate: 'support' };
      }
      return endNode;
    },
  }),
  [
    { id: 'billing', label: 'Billing' },
    { id: 'support', label: 'Support' },
    { id: 'agent', label: 'Talk to a human' },
  ],
);

const supportFlow = defineFlow({
  name: 'support',
  description: 'Shared omnichannel support flow',
  start: triageNode,
  nodes: [triageNode, endNode],
});

const supportAgent = defineAgent({
  id: 'support',
  name: 'Acme Support',
  model: openai('gpt-4o-mini'),
  instructions: `You are a helpful customer support agent for Acme Corp.
Be concise — messaging platforms have character limits.
Keep responses under 500 characters when possible.`,
  flows: [supportFlow],
});

const runtime = createRuntime({
  agents: [supportAgent],
  defaultAgentId: 'support',
  sessionStore: new MemoryStore(),
});

const whatsapp = createWhatsAppClient({
  accessToken: env('WHATSAPP_ACCESS_TOKEN'),
  appSecret: env('WHATSAPP_APP_SECRET'),
  phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
  verifyToken: env('WHATSAPP_VERIFY_TOKEN'),
});

const instagram = createInstagramClient({
  accessToken: env('INSTAGRAM_ACCESS_TOKEN'),
  appSecret: env('INSTAGRAM_APP_SECRET'),
  igId: env('INSTAGRAM_ACCOUNT_ID'),
  verifyToken: env('INSTAGRAM_VERIFY_TOKEN'),
});

const windowStore = new InMemoryWindowStore();
const sessionStore = runtime.getSessionStore();
const consent = sessionConsentStore(sessionStore, { defaultOptedIn: true });
const ownership = sessionOwnershipStore(sessionStore);

const eng = engagement({
  policies: [
    whatsappPolicy({
      client: whatsapp,
      selector: aiTemplateSelector(openai('gpt-4o-mini')),
      windowStore,
      wabaId: env('WHATSAPP_WABA_ID'),
    }),
    webPolicy(),
    instagramPolicy({ client: instagram, windowStore }),
  ],
  consent,
  ownership,
  windowStore,
});

const app = new Hono();

app.use('/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
}));

const messagingRouter = createMessagingRouter({
  runtime,
  platforms: { whatsapp, instagram },
  ...eng.bridge,
  onStatus: async (status) => {
    console.log(`[status] ${status.messageId} -> ${status.status}`);
  },
  onError: (error, ctx) => {
    console.error(`[${ctx.platform}] Error:`, error.message);
  },
});

app.route('/messaging', messagingRouter);
app.route('/', createKuralleChatRouter({ runtime }));

app.get('/health', (c) => c.json({
  status: 'ok',
  platforms: ['whatsapp', 'instagram', 'web'],
  engagement: eng.bridge.outbound?.map((m) => m.name),
  timestamp: new Date().toISOString(),
}));

const port = parseInt(process.env.PORT ?? '3333', 10);

console.log(`
  Multi-platform agent (engagement layer) on port ${port}

  WhatsApp webhook:  http://localhost:${port}/messaging/whatsapp/webhook
  Instagram webhook: http://localhost:${port}/messaging/instagram/webhook
  Web chat (SSE):    http://localhost:${port}/api/chat/sse
  Health check:      http://localhost:${port}/health

  One runtime, one flow — policies handle per-channel window + interactive rendering.
`);

serve({ fetch: app.fetch, port });
