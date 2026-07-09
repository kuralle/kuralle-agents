import { createRuntime, defineAgent, defineTool } from '@kuralle-agents/core';
import { defineSkill } from '../src/defineSkill.js';
import { z } from 'zod';

async function loadEnv(): Promise<void> {
  try {
    const { config } = await import('dotenv');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = dirname(fileURLToPath(import.meta.url));
    config({ path: join(dir, '../../../.env') });
  } catch {
    // optional in CI
  }
}

async function resolveModel() {
  const provider = process.env.KURALLE_EXAMPLE_PROVIDER?.trim().toLowerCase() ?? 'openai';
  if (provider !== 'openai') {
    throw new Error('Set KURALLE_EXAMPLE_PROVIDER=openai for this smoke.');
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is required for the live smoke.');
  const { createOpenAI } = await import('@ai-sdk/openai');
  const modelId = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
  return {
    model: createOpenAI({ apiKey: key })(modelId),
    label: `openai:${modelId}`,
  };
}

const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Fetch order status, items, and delivery date for an order id.',
  input: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => ({
    orderId,
    status: 'delivered',
    deliveredAt: '2026-05-01',
    daysSinceDelivery: 12,
    items: ['Wireless earbuds'],
  }),
});

const returnsPolicy = defineSkill({
  name: 'returns-policy',
  description:
    'Explains the 30-day return window, refund timelines, and exceptions. Use when the customer asks about returning, refunding, or exchanging an order.',
  allowedTools: ['lookup_order'],
  body: [
    '# Returns policy',
    '1. Confirm the order id, then run the `lookup_order` tool.',
    '2. If the order is fewer than 30 days old, it is returnable.',
    '3. State the refund timeline (5–7 business days to the original method).',
    '4. For gift cards or final-sale items, call read_skill_resource with exceptions.md.',
  ].join('\n'),
  resources: {
    'exceptions.md': '# Non-returnable\n- Gift cards\n- Final-sale items',
  },
});

async function main() {
  await loadEnv();
  const live = await resolveModel();

  const agent = defineAgent({
    id: 'support',
    model: live.model,
    instructions: 'You are a calm, precise support agent. Use skills and tools — never guess order facts.',
    tools: { lookup_order: lookupOrder },
    skills: [returnsPolicy],
    limits: { maxSteps: 8 },
  });

  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
  });

  const sessionId = `support-skill-${Date.now()}`;
  const handle = runtime.run({
    sessionId,
    input:
      'Can I return order A123? Load the returns-policy skill first, then lookup_order for A123, and tell me if it is returnable.',
  });

  const toolCalls: string[] = [];
  const toolTrace: unknown[] = [];
  let text = '';
  for await (const event of handle.events) {
    if (event.type === 'text-delta') text += event.delta;
    if (event.type === 'tool-call') {
      toolCalls.push(event.toolName);
      toolTrace.push({ kind: 'call', name: event.toolName, args: event.args });
    }
    if (event.type === 'tool-result') {
      toolTrace.push({ kind: 'result', name: event.toolName, result: event.result });
    }
  }
  await handle;

  const usedLoadSkill = toolCalls.includes('load_skill');
  const usedLookup = toolCalls.includes('lookup_order');
  const answer = (text || '').toLowerCase();

  console.log('model:', live.label);
  console.log('tool calls:', toolCalls);
  console.log('answer:', text);

  if (!usedLoadSkill || !usedLookup) {
    throw new Error(`Smoke expected load_skill + lookup_order (got: ${toolCalls.join(', ')})`);
  }
  if (!answer.includes('return') && !answer.includes('30')) {
    throw new Error(`Smoke answer missing return guidance: ${text.slice(0, 200)}`);
  }

  void toolTrace;
  void runtime;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
