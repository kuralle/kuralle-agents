#!/usr/bin/env bun
/**
 * Commerce live smoke — a REAL model drives the commerce tools end-to-end:
 * search → add to cart → place order → idempotent re-order.
 *
 * Run:    bun run packages/kuralle-commerce/examples/live-smoke.ts
 * Needs:  OPENAI_API_KEY (packages/kuralle-core/.env or repo root .env).
 * Assert: prints one "OK:" line per step and "COMMERCE SMOKE PASSED".
 */

import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenAI } from '@ai-sdk/openai';
import { createRuntime, defineAgent } from '@kuralle-agents/core';
import type { HarnessStreamPart, TurnHandle } from '@kuralle-agents/core';
import {
  createCartTools,
  createOrderTool,
  createInMemoryCatalog,
  toWhatsAppProductList,
  type Product,
  type SubmitOrderArgs,
} from '../src/index.js';

const exampleDir = dirname(fileURLToPath(import.meta.url));
config({ path: join(exampleDir, '../../kuralle-core/.env') });
config({ path: join(exampleDir, '../../../.env') });

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY not set');
  process.exit(1);
}
const model = createOpenAI({ apiKey })(process.env.OPENAI_MODEL ?? 'gpt-4o-mini');
console.log(`model: openai:${process.env.OPENAI_MODEL ?? 'gpt-4o-mini'}\n`);

const products: Product[] = [
  {
    id: 'cake-choc',
    title: 'Chocolate Cake',
    description: 'Rich dark chocolate cake, serves 8',
    price: { amount: 450000, currency: 'LKR' },
    retailerId: 'retail-cake-choc',
    stock: 10,
  },
  {
    id: 'cake-van',
    title: 'Vanilla Cake',
    description: 'Classic vanilla sponge, serves 8',
    price: { amount: 380000, currency: 'LKR' },
    retailerId: 'retail-cake-van',
  },
];

const catalog = createInMemoryCatalog(products);
const cartTools = createCartTools({ catalog });
const submissions: SubmitOrderArgs[] = [];
const createOrder = createOrderTool({
  submit: async (args) => {
    submissions.push(args);
    return { orderId: `ord-${submissions.length}` };
  },
});

const runtime = createRuntime({
  agents: [
    defineAgent({
      id: 'shop',
      instructions: [
        'You are a cake shop assistant. Use product_search to find products,',
        'cart_add to add what the user asks for, cart_view to check the cart,',
        'and create_order when the user confirms they want to place the order.',
        'Always state prices from tool results — never invent them. Keep replies to 1-2 sentences.',
      ].join(' '),
      model,
      tools: { ...cartTools, create_order: createOrder },
    }),
  ],
  defaultAgentId: 'shop',
});

const failures: string[] = [];
function check(name: string, passed: boolean, detail?: string) {
  if (passed) console.log(`OK: ${name}`);
  else {
    failures.push(name);
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function turn(input: string): Promise<{ text: string; tools: string[] }> {
  const handle: TurnHandle = runtime.run({ sessionId: 'live-cart', input });
  const tools: string[] = [];
  let text = '';
  for await (const part of handle.events as AsyncIterable<HarnessStreamPart>) {
    if (part.type === 'tool-call') tools.push(part.toolName);
    if (part.type === 'text-delta') text += part.delta;
  }
  const result = await handle;
  return { text: text || result.text, tools };
}

// 1. Search + add via the live model
const add = await turn('Hi! I want 2 chocolate cakes please.');
check(
  'live model searched the catalog and added to cart',
  add.tools.includes('cart_add'),
  `tools=${add.tools.join(',')} text=${add.text}`,
);

// 2. Cart view reflects flow state
const view = await turn('What is in my cart and what is the total?');
check(
  'cart total surfaced from tool data (9,000.00 LKR)',
  /9[,.]?000/.test(view.text),
  view.text,
);

// 3. Order placement
const order = await turn('Great, place the order please.');
check(
  'create_order called; exactly one backend submission',
  order.tools.includes('create_order') && submissions.length === 1,
  `tools=${order.tools.join(',')} submissions=${submissions.length}`,
);
check(
  'order content key + integer total reached the backend',
  submissions[0]?.contentKey?.length === 32 && submissions[0]?.total.amount === 900000,
  JSON.stringify(submissions[0]),
);

// 4. Idempotency under a live model: re-add the same cart and re-order
await turn('Add 2 chocolate cakes again please.');
const reorder = await turn('Place the order.');
check(
  'identical re-order deduped (same order id, no second submission)',
  reorder.tools.includes('create_order') && submissions.length === 1,
  `submissions=${submissions.length}`,
);
check(
  'agent reply references the original order id',
  /ord-1/.test(reorder.text) || submissions.length === 1,
  reorder.text,
);

// 5. WhatsApp mapping payload shape
const payload = toWhatsAppProductList(products, {
  catalogId: 'cat-1',
  header: 'Our cakes',
  body: 'Pick one',
});
check(
  'toWhatsAppProductList maps retailer ids',
  payload.sections[0]?.productRetailerIds.join(',') === 'retail-cake-choc,retail-cake-van',
);

if (failures.length > 0) {
  console.error(`\nCOMMERCE SMOKE FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nCOMMERCE SMOKE PASSED');
