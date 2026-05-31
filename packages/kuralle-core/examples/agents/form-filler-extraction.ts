#!/usr/bin/env node

import { z } from 'zod';
import { collect, defineFlow, reply } from '../../src/authoring/nodes.js';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { buildToolSet, defineTool } from '../../src/tools/effect/defineTool.js';
import { loadExampleEnv, runV2Conversation, requireLiveModel } from '../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);
const { model } = requireLiveModel();

const appointmentSchema = z.object({
  patient_name: z.string().min(1),
  date_of_birth: z.string().min(1),
  visit_type: z.string().min(1),
  symptoms: z.string().optional(),
  preferred_doctor: z.string().min(1),
  preferred_date: z.string().min(1),
  preferred_time: z.string().min(1),
  urgency: z.string().min(1),
  insurance_provider: z.string().min(1),
  callback_number: z.string().min(1),
  additional_notes: z.string().optional(),
});

const required = [
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

let submitted = false;

const endCall = defineTool({
  name: 'end_call',
  description: 'End the call politely when complete.',
  input: z.object({ message: z.string().optional() }),
  execute: async ({ message }) => ({
    endCall: true,
    message: message ?? 'Thanks for calling. We will contact you soon to confirm the appointment.',
  }),
});

const submitForm = defineTool({
  name: 'submit_form',
  description: 'Submit the collected appointment form once the user confirms.',
  input: z.object({}),
  execute: async (_args, ctx) => {
    const state = ctx!.runState.state;
    const missing = required.filter((k) => !state[k]);
    if (missing.length > 0) {
      return { success: false, message: `Cannot submit yet. Missing: ${missing.join(', ')}`, missing };
    }
    if (submitted) return { success: true, alreadySubmitted: true, message: 'Form already submitted.', formData: state };
    submitted = true;
    console.log('\nSubmitted form data:');
    console.log(JSON.stringify(state, null, 2));
    return { success: true, alreadySubmitted: false, message: 'Form submitted successfully.', formData: state };
  },
});

const confirm = reply({
  id: 'confirm',
  instructions: ({ state }) =>
    `Medical office assistant. Summarize the appointment: ${JSON.stringify(state)}. Ask for confirmation. ` +
    `If confirmed, call submit_form then end_call.`,
  model,
  tools: buildToolSet({ submit_form: submitForm, end_call: endCall }),
  next: (turn) => {
    if (turn.toolResults.some((r) => r.name === 'end_call')) return { end: 'scheduled' };
    if (turn.toolResults.some((r) => r.name === 'submit_form' && (r.result as { success?: boolean })?.success)) return 'stay';
    return 'stay';
  },
});

const intake = collect({
  id: 'intake',
  schema: appointmentSchema,
  required: [...required],
  maxTurns: 20,
  instructions: (missing) =>
    `Medical office assistant on the phone. Collect one field at a time. Missing: ${missing.join(', ') || 'none'}. ` +
    `Normalize visit_type (sick_visit, annual_physical, follow_up, new_concern, prescription_refill).`,
  onComplete: () => confirm,
});

const agent = defineAgent({
  id: 'form-filler-extraction-agent',
  name: 'Form Filler (Extraction-First)',
  model,
  effectTools: { submit_form: submitForm, end_call: endCall },
  flows: [
    defineFlow({
      name: 'intake',
      description: 'Collect appointment details',
      start: intake,
      nodes: [intake, confirm],
    }),
  ],
});

runV2Conversation({
  title: 'Form filler extraction (v2 collect)',
  agent,
  prompts: [
    'Hi, my name is Jordan Lee and my date of birth is January 1 1989.',
    'I need a sick visit because I have sore throat and fever.',
    'I prefer Dr Smith next Tuesday morning.',
    'Urgency is this week.',
    'Insurance is BlueCross and callback number is 415-555-1234.',
    'No additional notes.',
    'Yes that summary is correct, thanks bye.',
  ],
  onPart: (part) => {
    if (part.type === 'tool-call') console.log(`[Tool call] ${part.toolName}`);
    if (part.type === 'tool-result') console.log(`[Tool result] ${part.toolName}`);
  },
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
