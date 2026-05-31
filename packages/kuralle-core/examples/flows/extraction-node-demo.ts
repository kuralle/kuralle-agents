#!/usr/bin/env bun

import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { collect, defineFlow, reply } from '../../src/authoring/nodes.js';
import { buildToolSet, defineTool } from '../../src/tools/effect/defineTool.js';
import { loadExampleEnv, requireLiveModel, runV2Conversation } from '../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);
const { model } = requireLiveModel();

const contactSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(7),
  reason: z.string().min(1),
});

const end = reply({
  id: 'end',
  instructions: 'Thank the caller and let them know someone will be in touch.',
  model,
  next: () => ({ end: 'intake_complete' }),
});

const confirm = reply({
  id: 'confirm',
  instructions: ({ state }) =>
    `Review the collected information and confirm with the caller:
- Name: ${state.name}
- Phone: ${state.phone}
- Reason: ${state.reason}

Ask if everything is correct. If confirmed, call confirmed.`,
  model,
  tools: buildToolSet({
    confirmed: defineTool({
      name: 'confirmed',
      description: 'Caller confirmed the information is correct.',
      input: z.object({}),
      execute: async () => ({ ok: true }),
    }),
  }),
  next: (turn) => (turn.toolResults.some((r) => r.name === 'confirmed') ? end : 'stay'),
});

const collectInfo = collect({
  id: 'collect_info',
  schema: contactSchema,
  required: ['name', 'phone', 'reason'],
  maxTurns: 8,
  instructions: () =>
    'You are a friendly receptionist collecting contact information from the caller.',
  onComplete: (data) => ({ goto: confirm, data: data as Record<string, unknown> }),
});

const startCollection = defineTool({
  name: 'start_collection',
  description: 'Start collecting caller information.',
  input: z.object({}),
  execute: async () => ({ start: true }),
});

const greeting = reply({
  id: 'greeting',
  instructions:
    'Greet the caller and ask how you can help them today. Immediately transition to collect_info.',
  model,
  tools: buildToolSet({ start_collection: startCollection }),
  next: (turn) => (turn.toolResults.some((r) => r.name === 'start_collection') ? collectInfo : 'stay'),
});

const agent = defineAgent({
  id: 'extraction-demo',
  name: 'Extraction Node Demo',
  instructions: 'You are a friendly receptionist at a medical clinic.',
  model,
  flows: [
    defineFlow({
      name: 'intake',
      description: 'Collect contact info via collect node',
      start: greeting,
      nodes: [greeting, collectInfo, confirm, end],
    }),
  ],
});

runV2Conversation({
  title: 'ExtractionNode Demo (v2 collect)',
  agent,
  prompts: [
    'Hi there!',
    'What are your opening hours?',
    'Oh right, my name is Sarah Chen.',
    'banana',
    'Sorry, my phone is 555-0123.',
    'I need a follow-up for my knee.',
    'Yes, that is all correct.',
  ],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
