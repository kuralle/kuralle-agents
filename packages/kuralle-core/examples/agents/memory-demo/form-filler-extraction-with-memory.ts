#!/usr/bin/env node

/**
 * Form Filler (Extraction) + Memory Demo (v2)
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

const USER_ID = 'patient-jordan';
const model = openai(process.env.OPENAI_MODEL ?? 'gpt-4o-mini');

const appointmentSchema = z.object({
  patient_name: z.string().nullable(),
  date_of_birth: z.string().nullable(),
  visit_type: z.string().nullable(),
  symptoms: z.string().nullable(),
  preferred_doctor: z.string().nullable(),
  preferred_date: z.string().nullable(),
  preferred_time: z.string().nullable(),
  urgency: z.string().nullable(),
  insurance_provider: z.string().nullable(),
  callback_number: z.string().nullable(),
  additional_notes: z.string().nullable(),
});

const requiredFields = [
  'patient_name',
  'date_of_birth',
  'visit_type',
  'preferred_doctor',
  'preferred_date',
  'preferred_time',
  'urgency',
  'insurance_provider',
  'callback_number',
] as const;

const prompt = `You are a medical office assistant collecting appointment details.
You have long-term memory. If the patient called before, confirm recalled details and skip known fields.
Ask for one missing field at a time. Never invent values.
When all required fields are present, summarize and ask for confirmation.
Only call submit_form after explicit confirmation, then end_call.`;

let submitted = false;

const endCall = defineTool({
  name: 'end_call',
  description: 'End the call politely when complete.',
  input: z.object({ message: z.string().optional() }),
  execute: async ({ message }) => ({
    endCall: true,
    message: message || 'Thanks for calling. We will contact you soon to confirm the appointment.',
  }),
});

const submitForm = defineTool({
  name: 'submit_form',
  description: 'Submit the collected appointment form once the user confirms.',
  input: z.object({}),
  execute: async (_args, ctx) => {
    const state = ctx!.runState.state;
    const missing = requiredFields.filter((key) => {
      const value = state[key];
      return value === undefined || value === null || String(value).trim() === '';
    });
    if (missing.length > 0) {
      return { success: false, message: `Cannot submit yet. Missing: ${missing.join(', ')}`, missing };
    }
    if (submitted) {
      return { success: true, alreadySubmitted: true, formData: state };
    }
    submitted = true;
    console.log('\n  [Submitted form data]');
    console.log('  ' + JSON.stringify(state, null, 2).replace(/\n/g, '\n  '));
    return { success: true, formData: state };
  },
});

const confirm = reply({
  id: 'confirm',
  instructions: ({ state }) =>
    `Summarize the appointment: ${JSON.stringify(state)}. Ask for confirmation. On confirm call submit_form then end_call.`,
  model,
  tools: buildToolSet({ submit_form: submitForm, end_call: endCall }),
  next: (turn) => {
    if (turn.toolResults.some((r) => r.name === 'end_call')) return { end: 'scheduled' };
    return 'stay';
  },
});

const intake = collect({
  id: 'intake',
  schema: appointmentSchema,
  required: [...requiredFields],
  maxTurns: 20,
  instructions: (missing) =>
    `${prompt}\n\nMissing required fields: ${missing.join(', ') || 'none'}. ` +
    `For sick_visit or new_concern also collect symptoms if offered.`,
  onComplete: () => confirm,
});

const agent = defineAgent({
  id: 'form-filler-extraction-agent',
  name: 'Form Filler (Extraction + Memory)',
  model,
  instructions: prompt,
  memory: {
    preload: { enabled: true, tokenBudget: 2000 },
    ingest: { enabled: true },
  },
  effectTools: { submit_form: submitForm, end_call: endCall },
  flows: [
    defineFlow({
      name: 'appointment',
      description: 'Schedule appointment with memory',
      start: intake,
      nodes: [intake, confirm],
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
    if (part.type === 'tool-call') console.log(`  [Tool call] ${part.toolName}`);
    if (part.type === 'tool-result') console.log(`  [Tool result] ${part.toolName}`);
  }
  await handle;
  console.log(`  Assistant: ${response.trim()}`);
  return response;
}

async function main() {
  console.log('=== Form Filler (Extraction) + Memory Demo (v2) ===\n');

  separator('SESSION 1: First appointment booking');
  for (const input of [
    'Hi, my name is Jordan Lee and my date of birth is January 1 1989.',
    'I need a sick visit because I have sore throat and fever.',
    'I prefer Dr Smith next Tuesday morning.',
    'Urgency is this week.',
    'Insurance is BlueCross and callback number is 415-555-1234.',
    'No additional notes.',
    'Yes that summary is correct, thanks bye.',
  ]) {
    await chat('session-1', input);
  }

  const memories = await memoryService.searchMemory({
    userId: USER_ID,
    query: 'Jordan Lee BlueCross appointment',
    limit: 10,
  });
  separator('Ingested Memories');
  console.log(`  Total: ${memories.memories.length} entries`);
  for (const mem of memories.memories) {
    console.log(`  [${mem.author}] ${mem.content.slice(0, 120)}`);
  }

  separator('SESSION 2: Return visit');
  submitted = false;

  for (const input of [
    'Hi, this is Jordan Lee calling back. I need to schedule a follow-up appointment.',
    'Yes my details are the same — Jordan Lee, born January 1 1989, BlueCross insurance, callback 415-555-1234.',
    'I want to see Dr Johnson next Friday afternoon.',
    'Urgency is next week.',
    'No additional notes.',
    'Yes that looks correct, thanks!',
  ]) {
    await chat('session-2', input);
  }

  separator('Done');
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
