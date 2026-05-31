import { openai } from '@ai-sdk/openai';
import { defineAgent, defineTool, buildToolSet, defineFlow, reply } from '@kuralle-agents/core';
import { z } from 'zod';

// Minimal: chat agent with no flows or routing
const chatAgent = defineAgent({
  id: 'chat',
  instructions: 'You are a helpful assistant.',
  model: openai('gpt-4o-mini'),
});

// Tool agent: model-visible tools + durable executors
const lookup = defineTool({
  name: 'lookup',
  description: 'Look up a product by ID',
  input: z.object({ id: z.string() }),
  execute: async ({ id }) => ({ name: `Product ${id}`, price: 49.99 }),
});

const toolAgent = defineAgent({
  id: 'catalog',
  instructions: 'Answer product questions using the lookup tool.',
  model: openai('gpt-4o-mini'),
  tools: buildToolSet({ lookup }),   // model-visible
  effectTools: { lookup },           // durable executor — logged and replay-safe
});

// Flow agent: behavior driven by the flow graph, not the instructions alone
const done = reply({
  id: 'done',
  instructions: 'Confirm and end the conversation.',
  next: () => ({ end: 'complete' }),
});

const flowAgent = defineAgent({
  id: 'booking',
  instructions: 'You guide users through a booking.',
  model: openai('gpt-4o-mini'),
  flows: [
    defineFlow({
      name: 'booking',
      description: 'Guide the user through the booking process',
      start: done,
      nodes: [done],
    }),
  ],
});
