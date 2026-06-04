#!/usr/bin/env node

/**
 * Handoff Filters Demo — Context filtering during agent handoffs (v2)
 */

import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import readline from 'readline';
import { defineAgent } from '../../../src/authoring/defineAgent.js';
import { buildToolSet, defineTool } from '../../../src/tools/effect/defineTool.js';
import { createRuntime } from '../../../src/runtime/Runtime.js';
import { MemoryStore } from '../../../src/session/stores/MemoryStore.js';
import {
  handoffFilters,
  composeFilters,
} from '../../../src/runtime/handoffFilters.js';
import { loadExampleEnv } from '../../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required');
  process.exit(1);
}

const model = openai('gpt-4o-mini');

const lookupOrder = defineTool({
  name: 'lookupOrder',
  description: 'Look up an order by ID',
  input: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => ({
    orderId,
    status: 'shipped',
    items: ['Widget A', 'Gadget B'],
    total: 59.99,
    trackingNumber: 'TRK-12345',
  }),
});

const processRefund = defineTool({
  name: 'processRefund',
  description: 'Process a refund for an order',
  input: z.object({
    orderId: z.string(),
    reason: z.string(),
  }),
  execute: async ({ orderId, reason }) => ({
    success: true,
    refundId: `REF-${orderId}`,
    amount: 59.99,
    message: `Refund processed for ${orderId}: ${reason}`,
  }),
});

const supportAgent = defineAgent({
  id: 'support',
  name: 'Support Agent',
  model,
  instructions: `You are a customer support agent. Help users with order inquiries.
Use the lookupOrder tool to find order details.
If the user wants a refund, hand off to the refunds team.`,
  tools: buildToolSet({ lookupOrder }),
  handoffs: ['refunds'],
});

const refundAgent = defineAgent({
  id: 'refunds',
  name: 'Refund Specialist',
  model,
  instructions: `You are a refund specialist. Process refund requests.
Use the processRefund tool to issue refunds.
You receive only recent conversation context (tool history is filtered out).`,
  tools: buildToolSet({ processRefund }),
});

const triageAgent = defineAgent({
  id: 'triage',
  name: 'Router',
  model,
  instructions: 'Route users to the appropriate agent based on their request.',
  routes: [
    { agent: 'support', when: 'General support and order inquiries' },
    {
      agent: 'refunds',
      when: 'Refund requests and returns',
      filter: composeFilters(handoffFilters.removeToolHistory, handoffFilters.keepRecentMessages(5)),
    },
  ],
  routing: { default: 'support', mode: 'structured' },
  agents: [supportAgent, refundAgent],
});

const runtime = createRuntime({
  agents: [triageAgent, supportAgent, refundAgent],
  defaultAgentId: 'triage',
  defaultModel: model,
  sessionStore: new MemoryStore(),
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));

async function main() {
  console.log('=== Kuralle Handoff Filters Demo (v2) ===');
  console.log('1. Ask about an order (routes to support)');
  console.log('2. Request a refund (routes to refunds with filtered context)');
  console.log('Type "quit" to exit.\n');

  const sessionId = 'handoff-demo-session';

  while (true) {
    const input = await ask('You: ');
    if (input.trim() === 'quit') break;

    process.stdout.write('Agent: ');
    const handle = runtime.run({ sessionId, input });
    for await (const part of handle.events) {
      if (part.type === 'text-delta') process.stdout.write(part.delta);
      if (part.type === 'handoff') {
        console.log(`\n  [Handoff] → ${part.targetAgent} (reason: ${part.reason ?? ''})`);
        process.stdout.write('Agent: ');
      }
    }
    await handle;
    console.log('\n');
  }

  rl.close();
}

main().catch(console.error);
