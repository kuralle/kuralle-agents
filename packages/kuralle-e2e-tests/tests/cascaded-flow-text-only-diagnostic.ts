#!/usr/bin/env npx tsx
/**
 * Diagnostic — cascaded flow agent through real Gemini Flash, text-only.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tool } from 'ai';
import { z } from 'zod';
import { google } from '@ai-sdk/google';

import {
  Runtime,
  createFlowTransition,
  defineAgent,
  defineFlow,
  reply,
} from '@kuralle-agents/core';
import type { HarnessStreamPart } from '@kuralle-agents/core';

function readCurrentNode(session: {
  agentStates?: Record<string, { state?: { context?: { currentNode?: string } } }>;
} | null): string | undefined {
  return session?.agentStates?.['ecom-support']?.state?.context?.currentNode;
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
try {
  for (const line of readFileSync(join(root, '.env'), 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
} catch {
  /* no .env */
}

if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY && !process.env.GOOGLE_API_KEY) {
  console.log('SKIP: set GOOGLE_GENERATIVE_AI_API_KEY for this diagnostic');
  process.exit(0);
}

const toolLog: string[] = [];
const flashModel = google('gemini-3-flash-preview');

const trackingNode = reply({
  id: 'tracking',
  instructions: 'Ask for order number, then use lookup_order.',
  tools: {
    lookup_order: tool({
      description: 'Look up order status by order number',
      inputSchema: z.object({ orderNumber: z.string() }),
      execute: async ({ orderNumber }) => {
        console.log(`  [tool] lookup_order("${orderNumber}")`);
        toolLog.push(`lookup_order:${orderNumber}`);
        return { orderNumber, status: 'shipped', carrier: 'FedEx', eta: 'Tomorrow' };
      },
    }),
  },
});

const hubNode = reply({
  id: 'hub',
  instructions: 'If the customer wants to track an order, use route_to_tracking.',
  tools: {
    route_to_tracking: tool({
      description: 'Route to order tracking',
      inputSchema: z.object({}),
      execute: async () => {
        console.log('  [tool] route_to_tracking');
        toolLog.push('route_to_tracking');
        return createFlowTransition('tracking');
      },
    }),
  },
});

const ecomFlow = defineFlow({
  name: 'ecom-support',
  description: 'E-commerce customer service',
  start: hubNode,
  nodes: [hubNode, trackingNode],
});

const runtime = new Runtime({
  agents: [
    defineAgent({
      id: 'ecom-support',
      name: 'E-Commerce Support',
      model: flashModel,
      instructions: [
        'You are a helpful customer service agent for ShopNow.',
        'CRITICAL: Use the available tools when routing or looking up orders.',
      ].join('\n'),
      flows: [ecomFlow],
    }),
  ],
  defaultAgentId: 'ecom-support',
  defaultModel: flashModel,
});

async function turn(label: string, sessionId: string, input: string): Promise<void> {
  console.log(`\n── ${label} ──`);
  console.log(`  user: ${input}`);

  const parts: HarnessStreamPart[] = [];
  const handle = runtime.run({ input, sessionId });
  for await (const part of handle.events) {
    parts.push(part);
  }

  let assistantText = '';
  for (const p of parts) {
    if (p.type === 'text-delta') assistantText += p.text;
    if (p.type === 'tool-call') {
      console.log(`  → tool-call: ${p.toolName} args=${JSON.stringify(p.args)}`);
    }
    if (p.type === 'tool-result') {
      console.log(`  → tool-result: ${p.toolName} = ${JSON.stringify(p.result)}`);
    }
    if (p.type === 'flow-transition') {
      console.log(`  → flow-transition: ${p.from} → ${p.to}`);
    }
  }

  const session = await runtime.getSessionStore().get(sessionId);
  console.log(`  node after turn: ${readCurrentNode(session) ?? '(unknown)'}`);
  console.log(`  assistant: ${assistantText.trim() || '(no text)'}`);
}

async function main(): Promise<void> {
  const sessionId = `diag-${Date.now()}`;
  await turn('Turn 1 — route to tracking', sessionId, 'I want to track my order');
  await turn('Turn 2 — lookup order', sessionId, 'Order number ORD-10042');
  console.log(`\nTool log: ${toolLog.join(', ') || '(none)'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
