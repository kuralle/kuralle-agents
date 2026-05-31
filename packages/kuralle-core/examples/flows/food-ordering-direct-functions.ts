#!/usr/bin/env bun

import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { action, defineFlow, reply } from '../../src/authoring/nodes.js';
import { buildToolSet, defineTool } from '../../src/tools/effect/defineTool.js';
import { loadExampleEnv, requireLiveModel, runV2Conversation } from '../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);
const { model } = requireLiveModel();

const roleMessage =
  'You are an order-taking assistant. You must ALWAYS use the available functions to progress the conversation. This is a phone conversation and your responses will be converted to audio. Keep the conversation friendly, casual, and polite. Avoid outputting special characters and emojis.';

// Per-node `tools` (buildToolSet) is the model-visible *schema* only — the AI SDK
// entry carries no executor. The executors run through the agent's `effectTools`
// (see `effectTools` on the agent below). Define each tool once and reference it
// from both places.
const getDeliveryEstimate = defineTool({
  name: 'get_delivery_estimate',
  description: 'Provide delivery estimate information.',
  input: z.object({}),
  // NOTE: flow-node tool executors are not passed the flow run context, so this
  // cannot read `ctx.runState.state` — return a static estimate. To act on the
  // collected order, use an `action` node (which receives flow state directly).
  execute: async () => ({
    time: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  }),
});

const completeOrder = defineTool({
  name: 'complete_order',
  description: 'User confirms the order is correct.',
  input: z.object({}),
  execute: async () => ({ done: true }),
});

const reviseOrder = defineTool({
  name: 'revise_order',
  description: 'User wants to make changes to their order.',
  input: z.object({}),
  execute: async () => ({ revise: true }),
});

const selectPizzaOrder = defineTool({
  name: 'select_pizza_order',
  description: 'Record the pizza order details.',
  input: z.object({
    size: z.enum(['small', 'medium', 'large']),
    pizza_type: z.enum(['pepperoni', 'cheese', 'supreme', 'vegetarian']),
  }),
  execute: async ({ size, pizza_type }) => {
    const basePrice: Record<string, number> = { small: 10, medium: 15, large: 20 };
    const price = basePrice[size];
    return { order: { type: 'pizza', size, pizza_type, price }, size, type: pizza_type, price };
  },
});

const selectSushiOrder = defineTool({
  name: 'select_sushi_order',
  description: 'Record the sushi order details.',
  input: z.object({
    count: z.number().int().min(1).max(10),
    roll_type: z.enum(['california', 'spicy tuna', 'rainbow', 'dragon']),
  }),
  execute: async ({ count, roll_type }) => {
    const price = count * 8;
    return { order: { type: 'sushi', count, roll_type, price }, count, type: roll_type, price };
  },
});

const choosePizzaTool = defineTool({
  name: 'choose_pizza',
  description: "User wants to order pizza. Let's get that order started.",
  input: z.object({}),
  execute: async () => ({ choice: 'pizza' }),
});

const chooseSushiTool = defineTool({
  name: 'choose_sushi',
  description: "User wants to order sushi. Let's get that order started.",
  input: z.object({}),
  execute: async () => ({ choice: 'sushi' }),
});

const end = reply({
  id: 'end',
  instructions: 'Thank the user for their order and end the conversation politely and concisely.',
  model,
  next: () => ({ end: 'order_completed' }),
});

const confirm = reply({
  id: 'confirm',
  instructions: `Read back the complete order details to the user and ask if they want anything else or if they want to make changes. Use the available functions:
- Use complete_order when the user confirms that the order is correct and no changes are needed
- Use revise_order if they want to change something

Be friendly and clear when reading back the order details.`,
  model,
  tools: () => buildToolSet({ get_delivery_estimate: getDeliveryEstimate, complete_order: completeOrder, revise_order: reviseOrder }),
  next: (turn) => {
    if (turn.toolResults.some((r) => r.name === 'complete_order')) return end;
    if (turn.toolResults.some((r) => r.name === 'revise_order')) return initial;
    return 'stay';
  },
});

const choosePizza = reply({
  id: 'choose_pizza',
  instructions: `You are handling a pizza order. Use the available functions:
- Use select_pizza_order when the user specifies both size AND type

Pricing:
- Small: $10
- Medium: $15
- Large: $20

Remember to be friendly and casual.`,
  model,
  tools: () => buildToolSet({ get_delivery_estimate: getDeliveryEstimate, select_pizza_order: selectPizzaOrder }),
  next: (turn) => {
    const r = turn.toolResults.find((t) => t.name === 'select_pizza_order');
    if (r?.result) return { goto: confirm, data: r.result as Record<string, unknown> };
    return 'stay';
  },
});

const chooseSushi = reply({
  id: 'choose_sushi',
  instructions: `You are handling a sushi order. Use the available functions:
- Use select_sushi_order when the user specifies both count AND type

Pricing:
- $8 per roll

Remember to be friendly and casual.`,
  model,
  tools: () => buildToolSet({ get_delivery_estimate: getDeliveryEstimate, select_sushi_order: selectSushiOrder }),
  next: (turn) => {
    const r = turn.toolResults.find((t) => t.name === 'select_sushi_order');
    if (r?.result) return { goto: confirm, data: r.result as Record<string, unknown> };
    return 'stay';
  },
});

const initial = reply({
  id: 'initial',
  instructions: `${roleMessage}\n\nFor this step, ask the user if they want pizza or sushi, and wait for them to use a function to choose. Start off by greeting them. Be friendly and casual; you're taking an order for food over the phone.`,
  model,
  tools: () => buildToolSet({ get_delivery_estimate: getDeliveryEstimate, choose_pizza: choosePizzaTool, choose_sushi: chooseSushiTool }),
  next: (turn) => {
    if (turn.toolResults.some((r) => r.name === 'choose_pizza')) return choosePizza;
    if (turn.toolResults.some((r) => r.name === 'choose_sushi')) return chooseSushi;
    return 'stay';
  },
});

const kitchenCheck = action({
  id: 'kitchen_check',
  run: async () => {
    console.log('[Action] Checking kitchen status');
    return initial;
  },
});

const agent = defineAgent({
  id: 'food-ordering-direct-functions',
  name: 'Food Ordering Direct Functions (Pipecat parity)',
  instructions: roleMessage,
  model,
  // Register every per-node tool's executor. Per-node `tools` only shows the model
  // the schema; without this, calling a node tool throws "Unknown tool".
  effectTools: {
    get_delivery_estimate: getDeliveryEstimate,
    choose_pizza: choosePizzaTool,
    choose_sushi: chooseSushiTool,
    select_pizza_order: selectPizzaOrder,
    select_sushi_order: selectSushiOrder,
    complete_order: completeOrder,
    revise_order: reviseOrder,
  },
  flows: [
    defineFlow({
      name: 'order',
      description: 'Take a pizza or sushi order',
      start: kitchenCheck,
      nodes: [kitchenCheck, initial, choosePizza, chooseSushi, confirm, end],
    }),
  ],
});

runV2Conversation({
  title: 'Pipecat Food Ordering Direct Functions (v2)',
  agent,
  prompts: ['Hi', 'Sushi please', '2 spicy tuna rolls', 'What is the delivery estimate?', 'Looks good'],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
