import { Hono } from 'hono';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import {
  collect,
  createRuntime,
  decide,
  defineAgent,
  defineFlow,
  MemoryStore,
  reply,
} from '@kuralle-agents/core';
import { createMessagingRouter, type WindowStore } from '@kuralle-agents/messaging';
import type { WhatsAppClient } from '@kuralle-agents/messaging-meta/whatsapp';
import {
  aiTemplateSelector,
  engagement,
  sessionConsentStore,
  sessionOwnershipStore,
  webPolicy,
  whatsappPolicy,
  withChoices,
  type TemplateSelector,
} from '@kuralle-agents/engagement';

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
  description: 'WhatsApp support flow',
  start: triageNode,
  nodes: [triageNode, endNode],
});

export type WhatsAppServerAppOptions = {
  whatsapp: WhatsAppClient;
  model: LanguageModel;
  wabaId: string;
  windowStore: WindowStore;
  selector?: TemplateSelector;
};

export function createWhatsAppServerApp(options: WhatsAppServerAppOptions): Hono {
  const { whatsapp, model, wabaId, windowStore } = options;
  const selector = options.selector ?? aiTemplateSelector(model);

  const supportAgent = defineAgent({
    id: 'support',
    name: 'Acme Support',
    model,
    instructions: `You are a helpful customer support agent for Acme Corp.
Be concise — WhatsApp messages should stay under 500 characters when possible.`,
    flows: [supportFlow],
  });

  const runtime = createRuntime({
    agents: [supportAgent],
    defaultAgentId: 'support',
    sessionStore: new MemoryStore(),
  });

  const sessionStore = runtime.getSessionStore();
  const consent = sessionConsentStore(sessionStore, { defaultOptedIn: true });
  const ownership = sessionOwnershipStore(sessionStore);

  const eng = engagement({
    policies: [
      whatsappPolicy({ client: whatsapp, selector, windowStore, wabaId }),
      webPolicy(),
    ],
    consent,
    ownership,
    windowStore,
  });

  const app = new Hono();

  const messagingRouter = createMessagingRouter({
    runtime,
    platforms: { whatsapp },
    ...eng.bridge,
    onStatus: async (status) => {
      console.log(`[status] ${status.messageId} -> ${status.status}`);
    },
    onError: (error, ctx) => {
      console.error(`[${ctx.platform}] Error:`, error.message);
    },
  });

  app.route('/messaging', messagingRouter);

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      platforms: ['whatsapp'],
      windowStore: process.env.REDIS_URL ? 'redis' : 'memory',
      engagement: eng.bridge.outbound?.map((m) => m.name),
      timestamp: new Date().toISOString(),
    }),
  );

  return app;
}
