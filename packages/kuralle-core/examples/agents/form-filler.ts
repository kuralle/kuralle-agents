#!/usr/bin/env node

import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { collect, defineFlow, reply } from '../../src/authoring/nodes.js';
import { buildToolSet, defineTool } from '../../src/tools/effect/defineTool.js';
import { loadExampleEnv, runV2Conversation, requireLiveModel } from '../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);
const { model } = requireLiveModel();

const schema = z.object({
  patientName: z.string().min(1),
  dateOfBirth: z.string().min(1),
  visitType: z.enum(['annual_physical', 'sick_visit', 'follow_up', 'new_concern', 'prescription_refill']),
  symptoms: z.string().optional(),
  symptomDuration: z.string().optional(),
  previousVisitDate: z.string().optional(),
  preferredDoctor: z.string().min(1),
  preferredDate: z.string().min(1),
  preferredTime: z.string().min(1),
  urgency: z.string().min(1),
  insuranceProvider: z.string().min(1),
  callbackNumber: z.string().min(1),
  additionalNotes: z.string().optional(),
});

const endCall = defineTool({
  name: 'end_call',
  description: 'End the call after confirmation.',
  input: z.object({ message: z.string().optional() }),
  execute: async () => ({ endCall: true }),
});

const confirm = reply({
  id: 'confirm',
  instructions: ({ state }) =>
    `Summarize ${JSON.stringify(state)} and ask the caller to confirm. On yes, call end_call.`,
  model,
  tools: buildToolSet({ end_call: endCall }),
  next: (turn) => (turn.toolResults.some((r) => r.name === 'end_call') ? { end: 'scheduled' } : 'stay'),
});

const intake = collect({
  id: 'intake',
  schema,
  required: ['patientName', 'dateOfBirth', 'visitType', 'preferredDoctor', 'preferredDate', 'preferredTime', 'urgency', 'insuranceProvider', 'callbackNumber'],
  maxTurns: 20,
  instructions: (missing) =>
    `Medical receptionist. Collect one field at a time. Missing: ${missing.join(', ') || 'none'}.`,
  onComplete: () => confirm,
});

const agent = defineAgent({
  id: 'form-filler',
  name: 'Appointment Scheduler',
  model,
  effectTools: { end_call: endCall },
  flows: [defineFlow({ name: 'intake', description: 'Schedule appointment', start: intake, nodes: [intake, confirm] })],
});

runV2Conversation({
  title: 'Form filler (v2 collect)',
  agent,
  prompts: [
    'Hi, I need to schedule an appointment.',
    'Jane Doe, DOB March 12 1985, sick visit with sore throat since yesterday.',
    'Dr Smith, next Tuesday morning, urgent this week, BlueCross, 555-0100.',
    'Yes, that is correct. Thanks!',
  ],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
