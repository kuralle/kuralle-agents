import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { tool } from 'ai';
import {
  createRuntime,
  defineAgent,
  defineFlow,
  reply,
  defineTool,
  type AgentConfig,
  type Runtime,
  type HarnessHooks,
} from '@kuralle-agents/core';
import { buildToolSet } from './buildToolSet.mjs';
import { wireTools, mergeHarnessTools } from '../runtime/v2Tools.js';

export { wireTools, mergeHarnessTools };

export function buildEcommerceAgents(model: LanguageModel): AgentConfig[] {
  const lookupOrder = defineTool({
    name: 'lookup_order',
    description: 'Look up order status by order number',
    input: z.object({ orderNumber: z.string().describe('Order number like ORD-10042') }),
    execute: async ({ orderNumber }) => ({
      orderNumber,
      status: 'shipped',
      carrier: 'FedEx',
      eta: 'Tomorrow by 5pm',
    }),
  });

  const routeToTracking = defineTool({
    name: 'route_to_tracking',
    description: 'Route to order tracking when customer wants to track an order',
    input: z.object({}),
    execute: async () => ({ routed: true }),
  });

  const backToHub = defineTool({
    name: 'back_to_hub',
    description: 'Return to main menu when tracking is done',
    input: z.object({}),
    execute: async () => ({ back: true }),
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

export function buildSingleAgent(model: LanguageModel): AgentConfig[] {
  const wired = wireTools({
    check_weather: tool({
      description: 'Check the current weather for a city',
      inputSchema: z.object({ city: z.string().describe('City name') }),
      execute: async ({ city }) => ({
        city,
        temperature: 22,
        unit: 'celsius',
        condition: 'partly cloudy',
      }),
    }),
    get_time: tool({
      description: 'Get the current time in a timezone',
      inputSchema: z.object({ timezone: z.string().describe('Timezone like Asia/Tokyo') }),
      execute: async ({ timezone }) => {
        try {
          return { timezone, time: new Date().toLocaleTimeString('en-US', { timeZone: timezone }) };
        } catch {
          return { timezone, time: new Date().toLocaleTimeString('en-US') };
        }
      },
    }),
  });

  return [
    defineAgent({
      id: 'assistant',
      name: 'Voice Assistant',
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

export function createScenarioRuntime(
  model: LanguageModel,
  scenario: 'ecommerce' | 'single' = 'ecommerce',
  hooks?: HarnessHooks,
): Runtime {
  const agents =
    scenario === 'single' ? buildSingleAgent(model) : buildEcommerceAgents(model);
  return createRuntime({
    agents,
    defaultAgentId: agents[0]!.id,
    defaultModel: model,
    voiceMode: true,
    tools: mergeHarnessTools(agents),
    hooks,
  });
}

export function createSupportRuntime(
  model: LanguageModel,
  supportTools: Record<string, { description: string; inputSchema: unknown; execute: (...args: unknown[]) => unknown }>,
  instructions: string,
): Runtime {
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
