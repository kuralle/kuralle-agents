import { z } from 'zod';
import {
  createRuntime,
  defineAgent,
  defineFlow,
  reply,
  defineTool,
} from '@kuralle-agents/core';
import { buildToolSet } from './buildToolSet.mjs';
import { wireTools, mergeHarnessTools } from '../runtime/v2Tools.mjs';

export { wireTools, mergeHarnessTools };

export function buildEcommerceAgents(model) {
  const lookupOrder = defineTool({
    name: 'lookup_order',
    description: 'Look up order status by order number',
    input: z.object({ orderNumber: z.string().describe('Order number like ORD-10042') }),
    execute: async ({ orderNumber }) => {
      console.log(`[tool] lookup_order("${orderNumber}")`);
      return { orderNumber, status: 'shipped', carrier: 'FedEx', eta: 'Tomorrow by 5pm' };
    },
  });

  const routeToTracking = defineTool({
    name: 'route_to_tracking',
    description: 'Route to order tracking when customer wants to track an order',
    input: z.object({}),
    execute: async () => {
      console.log('[tool] route_to_tracking');
      return { routed: true };
    },
  });

  const backToHub = defineTool({
    name: 'back_to_hub',
    description: 'Return to main menu when tracking is done',
    input: z.object({}),
    execute: async () => {
      console.log('[tool] back_to_hub');
      return { back: true };
    },
  });

  const tracking = reply({
    id: 'tracking',
    instructions: [
      'Help the customer track their order.',
      'Ask for order number if not provided.',
      'Use lookup_order once you have the order number.',
    ].join('\n'),
    model,
    tools: () => buildToolSet({ lookup_order: lookupOrder, back_to_hub: backToHub }),
    next: (turn) => {
      if (turn.toolResults.some((r) => r.name === 'back_to_hub')) return hub;
      return 'stay';
    },
  });

  const hub = reply({
    id: 'hub',
    instructions: [
      'You are the main customer service agent.',
      'Handle general questions directly.',
      'If the customer wants to track an order, use route_to_tracking.',
      'Store hours are 9am-6pm Mon-Sat.',
    ].join('\n'),
    model,
    tools: () => buildToolSet({ route_to_tracking: routeToTracking }),
    next: (turn) => {
      if (turn.toolResults.some((r) => r.name === 'route_to_tracking')) return tracking;
      return 'stay';
    },
  });

  const flow = defineFlow({
    name: 'ecom-support',
    description: 'Customer service with order tracking',
    start: hub,
    nodes: [hub, tracking],
  });

  const tools = {
    lookup_order: lookupOrder,
    route_to_tracking: routeToTracking,
    back_to_hub: backToHub,
  };

  return [
    defineAgent({
      id: 'ecom-support',
      name: 'E-Commerce Support',
      description: 'Customer service with order tracking',
      instructions: [
        'You are a helpful customer service agent for ShopNow, an online store.',
        'Be friendly and efficient. Keep responses to 1-2 sentences.',
        'CRITICAL: Use the available tools when routing or looking up orders.',
      ].join('\n'),
      model,
      flows: [flow],
      tools,
    }),
  ];
}

export function buildSingleAgentTools() {
  return wireTools({
    check_weather: {
      description: 'Check the current weather for a city',
      inputSchema: z.object({ city: z.string().describe('City name') }),
      execute: async ({ city }) => {
        console.log(`[tool] check_weather("${city}")`);
        return { city, temperature: 22, unit: 'celsius', condition: 'partly cloudy' };
      },
    },
    get_time: {
      description: 'Get the current time in a timezone',
      inputSchema: z.object({ timezone: z.string().describe('Timezone like Asia/Tokyo') }),
      execute: async ({ timezone }) => {
        console.log(`[tool] get_time("${timezone}")`);
        try {
          return { timezone, time: new Date().toLocaleTimeString('en-US', { timeZone: timezone }) };
        } catch {
          return { timezone, time: new Date().toLocaleTimeString('en-US') };
        }
      },
    },
  });
}

export function buildSingleAgent(model) {
  const wired = buildSingleAgentTools();
  return [
    defineAgent({
      id: 'assistant',
      name: 'Voice Assistant',
      description: 'A friendly voice assistant with tools',
      instructions: [
        'You are a friendly voice assistant.',
        'Keep responses to 1-2 sentences.',
        'Use check_weather when asked about weather.',
        'Use get_time when asked about the time.',
      ].join('\n'),
      model,
      tools: wired.tools,
    }),
  ];
}

export function buildTriageAgents(model) {
  const lookupOrder = defineTool({
    name: 'lookup_order',
    description: 'Look up order status by order number',
    input: z.object({ orderNumber: z.string() }),
    execute: async ({ orderNumber }) => ({
      orderNumber,
      status: 'shipped',
      carrier: 'FedEx',
      eta: 'Tomorrow by 5pm',
    }),
  });

  const checkBalance = defineTool({
    name: 'check_balance',
    description: 'Check account balance',
    input: z.object({ accountId: z.string() }),
    execute: async ({ accountId }) => ({
      accountId,
      balance: '$142.50',
      dueDate: '2026-05-01',
    }),
  });

  const tracking = defineAgent({
    id: 'tracking',
    name: 'Order Tracking Agent',
    model,
    instructions: [
      'You help customers track orders.',
      'Ask for the order number, then use lookup_order.',
      'Keep responses to 1-2 sentences.',
    ].join('\n'),
    tools: { lookup_order: lookupOrder },
    handoffs: ['triage'],
  });

  const billing = defineAgent({
    id: 'billing',
    name: 'Billing Agent',
    model,
    instructions: [
      'You help customers with billing questions.',
      'Use check_balance to look up account balance.',
      'Keep responses to 1-2 sentences.',
    ].join('\n'),
    tools: { check_balance: checkBalance },
    handoffs: ['triage'],
  });

  const triage = defineAgent({
    id: 'triage',
    name: 'Triage Hub',
    model,
    instructions: [
      'You are a customer service router.',
      'Route to the right specialist agent.',
      'If the user wants to track an order, hand off to tracking.',
      'If the user wants billing help, hand off to billing.',
      'Otherwise, answer general questions directly.',
    ].join('\n'),
    routes: [
      { agent: 'tracking', when: 'Order tracking and shipment status' },
      { agent: 'billing', when: 'Billing, balance, and payment questions' },
    ],
    routing: {},
    agents: [tracking, billing],
  });

  return [triage, tracking, billing];
}

export function createScenarioRuntime(model, scenario = 'ecommerce', hooks = {}) {
  const builders = {
    ecommerce: () => buildEcommerceAgents(model),
    single: () => buildSingleAgent(model),
    triage: () => buildTriageAgents(model),
  };
  const agents = (builders[scenario] ?? builders.ecommerce)();
  return createRuntime({
    agents,
    defaultAgentId: agents[0].id,
    defaultModel: model,
    voiceMode: true,
    tools: mergeHarnessTools(agents),
    hooks,
  });
}

export function createSupportRuntime(model, supportTools, instructions) {
  const wired = wireTools(supportTools);
  const agents = [
    defineAgent({
      id: 'support',
      name: 'Customer Support',
      instructions,
      model,
      tools: wired.tools,
    }),
  ];
  return createRuntime({
    agents,
    defaultAgentId: 'support',
    defaultModel: model,
    voiceMode: true,
    tools: wired.tools,
  });
}
