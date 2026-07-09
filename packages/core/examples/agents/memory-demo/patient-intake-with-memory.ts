#!/usr/bin/env node

/**
 * Patient Intake Flow + Memory Demo (v2)
 */

import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { defineAgent } from '../../../src/authoring/defineAgent.js';
import { collect, defineFlow, reply } from '../../../src/authoring/nodes.js';
import { buildToolSet, defineTool } from '../../../src/tools/effect/defineTool.js';
import { createRuntime } from '../../../src/runtime/Runtime.js';
import { InMemoryMemoryService } from '../../../src/memory/stores/InMemoryMemoryService.js';
import { MemoryStore } from '../../../src/session/stores/MemoryStore.js';
import { loadExampleEnv } from '../../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is required');
  process.exit(1);
}

const USER_ID = 'patient-chad';
const VERIFIED_BIRTHDAY = '1983-01-01';
const model = openai(process.env.OPENAI_MODEL ?? 'gpt-4o-mini');

const roleMessage = `You are Jessica, an agent for Tri-County Health Services. Be professional but friendly.

You have long-term memory of past patient interactions. If you recognize a returning patient:
- Greet them by name and confirm their identity with their birthday on file.
- Reference their known prescriptions, allergies, and conditions.
- Skip questions for information you already know — just confirm.
- Only ask about NEW information (e.g., new visit reasons).

Always use available functions to progress the conversation.`;

const end = reply({
  id: 'end',
  instructions: 'Thank them for their time and end the conversation.',
  next: () => ({ end: 'intake_completed' }),
});

const confirm = reply({
  id: 'confirm',
  instructions: 'Thank them, then call complete_intake to end the conversation.',
  model,
  tools: buildToolSet({
    complete_intake: defineTool({
      name: 'complete_intake',
      description: 'Complete the intake process',
      input: z.object({}),
      execute: async () => ({ completed: true }),
    }),
  }),
  next: (turn) => (turn.toolResults.some((r) => r.name === 'complete_intake') ? end : 'stay'),
});

const verify = reply({
  id: 'verify',
  instructions:
    'Review all collected information with the patient. Summarize prescriptions, allergies, conditions, and visit reasons. Ask if everything is correct.',
  model,
  context: 'reset_with_summary',
  tools: buildToolSet({
    revise_information: defineTool({
      name: 'revise_information',
      description: 'Return to prescriptions to revise information',
      input: z.object({}),
      execute: async () => ({ revise: true }),
    }),
    confirm_information: defineTool({
      name: 'confirm_information',
      description: 'Proceed with confirmed information',
      input: z.object({}),
      execute: async () => ({ confirmed: true }),
    }),
  }),
  next: (turn, state) => {
    if (turn.toolResults.some((r) => r.name === 'confirm_information')) return confirm;
    if (turn.toolResults.some((r) => r.name === 'revise_information')) return getPrescriptions;
    return 'stay';
  },
});

const visitReasonSchema = z.object({
  visit_reasons: z.array(z.object({ name: z.string() })).nullable(),
});

const getVisitReasons = collect({
  id: 'get_visit_reasons',
  schema: visitReasonSchema,
  required: ['visit_reasons'],
  instructions: () =>
    'Ask what brings them to the doctor today. This is always new — do not assume from memory.',
  onComplete: () => verify,
});

const conditionSchema = z.object({
  conditions: z.array(z.object({ name: z.string() })).nullable(),
});

const getConditions = collect({
  id: 'get_conditions',
  schema: conditionSchema,
  required: ['conditions'],
  instructions: () =>
    'Collect medical conditions. If you recall conditions from memory, confirm them first.',
  onComplete: () => getVisitReasons,
});

const allergySchema = z.object({
  allergies: z.array(z.object({ name: z.string() })).nullable(),
});

const getAllergies = collect({
  id: 'get_allergies',
  schema: allergySchema,
  required: ['allergies'],
  instructions: () =>
    'Collect allergy information. If you recall allergies from memory, confirm them first.',
  onComplete: () => getConditions,
});

const prescriptionSchema = z.object({
  prescriptions: z
    .array(z.object({ medication: z.string(), dosage: z.string() }))
    .nullable(),
});

const getPrescriptions = collect({
  id: 'get_prescriptions',
  schema: prescriptionSchema,
  required: ['prescriptions'],
  instructions: () =>
    'Collect prescriptions. If you recall prescriptions from memory, confirm them first.',
  onComplete: () => getAllergies,
});

const startSchema = z.object({
  birthday: z.string().nullable(),
});

const start = collect({
  id: 'start',
  schema: startSchema,
  required: ['birthday'],
  instructions: () =>
    `${roleMessage}\n\nIntroduce yourself. If you recall the patient from memory, greet them by name and confirm their birthday. Otherwise ask for date of birth including year.`,
  onComplete: (data, state) => {
    const birthday = (data as { birthday?: string }).birthday ?? '';
    state.birthday_verified = birthday === VERIFIED_BIRTHDAY;
    return getPrescriptions;
  },
});

const agent = defineAgent({
  id: 'patient-intake-flow',
  name: 'Patient Intake (Flow + Memory)',
  instructions: roleMessage,
  model,
  memory: {
    preload: { enabled: true },
    ingest: { enabled: true },
  },
  flows: [
    defineFlow({
      name: 'intake',
      description: 'Patient intake with memory',
      start: start,
      nodes: [start, getPrescriptions, getAllergies, getConditions, getVisitReasons, verify, confirm, end],
    }),
  ],
});

const memoryService = new InMemoryMemoryService();
const sessionStore = new MemoryStore();

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: agent.id,
  defaultModel: model,
  sessionStore,
  memoryService,
});

function separator(title: string) {
  console.log(`\n${'━'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'━'.repeat(60)}`);
}

async function chat(sessionId: string, input: string): Promise<string> {
  let response = '';
  console.log(`\n  User: ${input}`);
  const handle = runtime.run({ sessionId, input, userId: USER_ID });
  for await (const part of handle.events) {
    if (part.type === 'text-delta') response += part.delta;
    if (part.type === 'node-enter') console.log(`  [Node] ${part.nodeName}`);
    if (part.type === 'flow-transition') console.log(`  [Transition] ${part.from} → ${part.to}`);
    if (part.type === 'tool-call') console.log(`  [Tool call] ${part.toolName}`);
    if (part.type === 'tool-result') console.log(`  [Tool result] ${part.toolName}`);
  }
  await handle;
  console.log(`  Assistant: ${response.trim()}`);
  return response;
}

async function main() {
  console.log('=== Patient Intake Flow + Memory Demo (v2) ===\n');

  separator('SESSION 1: New patient intake');
  for (const input of [
    'Hi',
    'My birthday is January 1st 1983',
    'Lisinopril 10mg and Metformin 500mg',
    'Penicillin',
    'Type 2 diabetes',
    'Annual physical checkup',
    'Yes everything is correct',
  ]) {
    await chat('session-1', input);
  }

  const memories = await memoryService.searchMemory({
    userId: USER_ID,
    query: 'birthday prescriptions allergies conditions Lisinopril Metformin Penicillin diabetes',
    limit: 15,
  });
  separator('Ingested Memories');
  console.log(`  Total: ${memories.memories.length} entries`);
  for (const mem of memories.memories) {
    console.log(`  [${mem.author}] ${mem.content.slice(0, 120)}`);
  }

  separator('SESSION 2: Returning patient (new session)');
  for (const input of [
    'Hi, this is Chad Bailey again',
    'Yes, January 1st 1983 is correct',
    'No changes to my prescriptions',
    'Still just penicillin',
    'Same conditions, no changes',
    'I have been having headaches for the past week',
    'Yes that all looks right',
  ]) {
    await chat('session-2', input);
  }

  const session2 = await sessionStore.get('session-2');
  if (session2) {
    separator('Recall Verification');
    const allText = session2.messages
      .filter((m) => m.role === 'assistant')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join(' ')
      .toLowerCase();
    const checks = [
      ['Referenced Lisinopril', allText.includes('lisinopril')],
      ['Referenced Metformin', allText.includes('metformin')],
      ['Referenced Penicillin', allText.includes('penicillin')],
      ['Referenced diabetes', allText.includes('diabetes')],
    ];
    let passCount = 0;
    for (const [name, pass] of checks) {
      console.log(`  ${pass ? '✓' : '✗'} ${name}`);
      if (pass) passCount++;
    }
    console.log(`\n  Result: ${passCount}/${checks.length} recalled from memory`);
  }

  separator('Done');
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
