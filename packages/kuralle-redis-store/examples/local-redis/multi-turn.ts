import { config as loadEnv } from 'dotenv';
import { createClient } from 'redis';
import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { openai } from '@ai-sdk/openai';
import { tool } from 'ai';
import { z } from 'zod';
import { createRuntime, defineAgent } from '@kuralle-agents/core';
import { RedisSessionStore, type RedisClientLike } from '../../src/index.js';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '.env');
loadEnv({ path: envPath });

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
const prefix = 'kuralle-redis-demo';
const model = openai('gpt-4o-mini');

const logDir = join(dirname(fileURLToPath(import.meta.url)), 'logs');
mkdirSync(logDir, { recursive: true });
const transcriptFile = join(logDir, 'conversation.jsonl');
const sessionFile = join(logDir, 'session.json');
const rawFile = join(logDir, 'session.raw.json');

const logEvent = (event: Record<string, unknown>) => {
  appendFileSync(
    transcriptFile,
    `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`
  );
};

const lookupOrder = tool({
  description: 'Look up an order by ID',
  inputSchema: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => ({
    orderId,
    status: 'shipped',
    tracking: 'TRK-12345',
  }),
});

const processRefund = tool({
  description: 'Process a refund for an order',
  inputSchema: z.object({ orderId: z.string(), reason: z.string() }),
  execute: async ({ orderId, reason }) => ({
    success: true,
    refundId: `REF-${orderId}`,
    reason,
  }),
});

const supportAgent = defineAgent({
  id: 'support',
  name: 'Support',
  model,
  instructions: `You are customer support. Help with orders and shipping.
Use lookupOrder for order status. Hand off to refunds for refund requests.`,
  tools: { lookupOrder },
  handoffs: ['refunds'],
});

const refundAgent = defineAgent({
  id: 'refunds',
  name: 'Refunds',
  model,
  instructions: 'You process refunds. Use processRefund when details are clear.',
  tools: { processRefund },
});

const triageAgent = defineAgent({
  id: 'triage',
  name: 'Router',
  model,
  instructions: 'Route the user to support or refunds based on their request.',
  routes: [
    { agent: 'support', when: 'General support, orders, shipping, product issues' },
    { agent: 'refunds', when: 'Refunds, returns, billing disputes' },
  ],
  routing: { default: 'support', mode: 'structured' },
  agents: [supportAgent, refundAgent],
});

const conversationTurns = [
  'Hi, I need help with a few things today.',
  "I ordered some headphones last week and they haven't arrived yet. Also, I was charged twice for the order.",
  'The order number is ORD-12345.',
  'Can you track where my package is?',
  'When do you expect it to arrive?',
  'Is there any way to get it faster?',
  'About that double charge - I really need that refund processed.',
  'Yes, please refund it to my original payment method.',
  'How long will the refund take?',
  "By the way, I also have a problem with my other headphones that I bought before. They won't pair with my phone.",
  "I already tried turning them off and on. The blue light just blinks but my phone can't find them.",
  'Can you check if there are any system issues on your end?',
  'Let me try the reset procedure you mentioned.',
  "That worked! They're pairing now. Thanks!",
  'While I have you, is there a manual I can download for these headphones?',
  'Going back to my new order - can I modify the shipping address before it arrives?',
  "Actually, never mind. I'll just wait for it at the original address.",
  'Can you confirm my order status one more time?',
  'I think that covers everything. Can you give me a summary of what we resolved today?',
  'Great, thank you for all your help! Have a nice day.',
];

const run = async () => {
  const client = createClient({ url: redisUrl });
  client.on('error', (err) => {
    console.error('Redis client error:', err);
  });

  await client.connect();

  const store = new RedisSessionStore({
    client: client as unknown as RedisClientLike, // redis client command overloads don't match the minimal interface
    prefix,
    sessionTtlSeconds: 3600,
  });

  const runtime = createRuntime({
    agents: [triageAgent, supportAgent, refundAgent],
    defaultAgentId: 'triage',
    defaultModel: model,
    sessionStore: store,
  });

  let sessionId: string | undefined;

  for (let index = 0; index < conversationTurns.length; index += 1) {
    const message = conversationTurns[index];
    const turn = index + 1;

    logEvent({ event: 'user', turn, text: message, sessionId });
    let response = '';

    const handle = runtime.run({ input: message, sessionId });
    for await (const part of handle.events) {
      if (part.type === 'text-delta') {
        response += part.delta;
      }

      if (part.type === 'handoff') {
        logEvent({ event: 'handoff', turn, targetAgent: part.targetAgent, reason: part.reason });
      }

      if (part.type === 'done') {
        sessionId = part.sessionId;
      }

      if (part.type === 'error') {
        logEvent({ event: 'error', turn, error: part.error });
      }
    }
    await handle;

    logEvent({ event: 'assistant', turn, text: response, sessionId });
  }

  if (!sessionId) {
    throw new Error('No sessionId returned from Runtime');
  }

  const saved = await store.get(sessionId);
  const raw = await client.get(`${prefix}:session:${sessionId}`);

  writeFileSync(sessionFile, JSON.stringify(saved, null, 2));
  writeFileSync(rawFile, raw ?? '');

  console.log('Session saved to:', sessionFile);
  console.log('Raw Redis JSON saved to:', rawFile);
  console.log('Session messages:', saved?.messages.length ?? 0);

  await client.disconnect();
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
