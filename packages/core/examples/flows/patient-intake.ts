#!/usr/bin/env bun

import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { defineFlow, reply } from '../../src/authoring/nodes.js';
import { buildToolSet, defineTool } from '../../src/tools/effect/defineTool.js';
import { loadExampleEnv, requireLiveModel, runV2Conversation } from '../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);
const { model } = requireLiveModel();

const VERIFIED_BIRTHDAY = '1983-01-01';
const roleMessage =
  'You are Jessica, an agent for Tri-County Health Services. You must ALWAYS use one of the available functions to progress the conversation. Be professional but friendly.';

const end = reply({
  id: 'end',
  instructions: 'Thank them for their time and end the conversation.',
  model,
  next: () => ({ end: 'intake_completed' }),
});

const confirm = reply({
  id: 'confirm',
  instructions:
    'Once confirmed, thank them, then use the complete_intake function to end the conversation.',
  model,
  tools: buildToolSet({
    complete_intake: defineTool({
      name: 'complete_intake',
      description: 'Complete the intake process',
      input: z.object({}),
      execute: async () => ({ done: true }),
    }),
  }),
  next: (turn) => (turn.toolResults.some((r) => r.name === 'complete_intake') ? end : 'stay'),
});

const verify = reply({
  id: 'verify',
  instructions: `Review all collected information with the patient. Follow these steps:
1. Summarize their prescriptions, allergies, conditions, and visit reasons
2. Ask if everything is correct
3. Use the appropriate function based on their response

Be thorough in reviewing all details and wait for explicit confirmation.`,
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
  next: (turn) => {
    if (turn.toolResults.some((r) => r.name === 'revise_information')) return getPrescriptions;
    if (turn.toolResults.some((r) => r.name === 'confirm_information')) return confirm;
    return 'stay';
  },
});

const getVisitReasons = reply({
  id: 'get_visit_reasons',
  instructions:
    'Collect information about the reason for their visit. Ask what brings them to the doctor today. After recording their reasons, proceed to verification.',
  model,
  tools: buildToolSet({
    record_visit_reasons: defineTool({
      name: 'record_visit_reasons',
      description: 'Record the reasons for their visit. Once confirmed, the next step is to verify all information.',
      input: z.object({
        visit_reasons: z.array(z.object({ name: z.string().describe("The user's reason for visiting") })),
      }),
      execute: async ({ visit_reasons }) => ({ visit_reasons, visit_reason_count: visit_reasons.length }),
    }),
  }),
  next: (turn) => {
    const r = turn.toolResults.find((t) => t.name === 'record_visit_reasons');
    if (r?.result) return { goto: verify, data: r.result as Record<string, unknown> };
    return 'stay';
  },
});

const getConditions = reply({
  id: 'get_conditions',
  instructions:
    'Collect medical condition information. Ask about any medical conditions they have. After recording conditions (or confirming none), proceed to visit reasons.',
  model,
  tools: buildToolSet({
    record_conditions: defineTool({
      name: 'record_conditions',
      description: "Record the user's medical conditions. Once confirmed, the next step is to collect visit reasons.",
      input: z.object({
        conditions: z.array(z.object({ name: z.string().describe("The user's medical condition") })),
      }),
      execute: async ({ conditions }) => ({ conditions, condition_count: conditions.length }),
    }),
  }),
  next: (turn) => {
    const r = turn.toolResults.find((t) => t.name === 'record_conditions');
    if (r?.result) return { goto: getVisitReasons, data: r.result as Record<string, unknown> };
    return 'stay';
  },
});

const getAllergies = reply({
  id: 'get_allergies',
  instructions:
    'Collect allergy information. Ask about any allergies they have. After recording allergies (or confirming none), proceed to medical conditions.',
  model,
  tools: buildToolSet({
    record_allergies: defineTool({
      name: 'record_allergies',
      description: "Record the user's allergies. Once confirmed, then next step is to collect medical conditions.",
      input: z.object({
        allergies: z.array(z.object({ name: z.string().describe('What the user is allergic to') })),
      }),
      execute: async ({ allergies }) => ({ allergies, allergy_count: allergies.length }),
    }),
  }),
  next: (turn) => {
    const r = turn.toolResults.find((t) => t.name === 'record_allergies');
    if (r?.result) return { goto: getConditions, data: r.result as Record<string, unknown> };
    return 'stay';
  },
});

const getPrescriptions = reply({
  id: 'get_prescriptions',
  instructions: `${roleMessage}\n\nThis step is for collecting prescriptions. Ask them what prescriptions they're taking, including the dosage. Get to the point by saying 'Thanks for confirming that. First up, what prescriptions are you currently taking, including the dosage for each medication?'. After recording prescriptions (or confirming none), proceed to allergies.`,
  model,
  context: 'reset',
  tools: buildToolSet({
    record_prescriptions: defineTool({
      name: 'record_prescriptions',
      description: "Record the user's prescriptions. Once confirmed, the next step is to collect allergy information.",
      input: z.object({
        prescriptions: z.array(
          z.object({
            medication: z.string().describe("The medication's name"),
            dosage: z.string().describe("The prescription's dosage"),
          }),
        ),
      }),
      execute: async ({ prescriptions }) => ({ prescriptions, prescription_count: prescriptions.length }),
    }),
  }),
  next: (turn) => {
    const r = turn.toolResults.find((t) => t.name === 'record_prescriptions');
    if (r?.result) return { goto: getAllergies, data: r.result as Record<string, unknown> };
    return 'stay';
  },
});

const start = reply({
  id: 'start',
  instructions: `${roleMessage}\n\nStart by introducing yourself to Chad Bailey, then ask for their date of birth, including the year. Once they provide their birthday, use verify_birthday to check it. If verified (1983-01-01), proceed to prescriptions.`,
  model,
  tools: buildToolSet({
    verify_birthday: defineTool({
      name: 'verify_birthday',
      description:
        "Verify the user has provided their correct birthday. Once confirmed, the next step is to record the user's prescriptions.",
      input: z.object({
        birthday: z.string().describe("The user's birthdate (convert to YYYY-MM-DD format)"),
      }),
      execute: async ({ birthday }) => ({
        birthday,
        birthday_verified: birthday === VERIFIED_BIRTHDAY,
      }),
    }),
  }),
  next: (turn) => {
    const r = turn.toolResults.find((t) => t.name === 'verify_birthday');
    if (r?.result) return { goto: getPrescriptions, data: r.result as Record<string, unknown> };
    return 'stay';
  },
});

const agent = defineAgent({
  id: 'patient-intake-flow',
  name: 'Patient Intake (Pipecat parity)',
  instructions: roleMessage,
  model,
  flows: [
    defineFlow({
      name: 'intake',
      description: 'Medical patient intake',
      start: start,
      nodes: [start, getPrescriptions, getAllergies, getConditions, getVisitReasons, verify, confirm, end],
    }),
  ],
});

runV2Conversation({
  title: 'Pipecat Patient Intake (v2)',
  agent,
  prompts: [
    'Hi',
    'My birthday is 1983-01-01',
    'Lisinopril 10mg and Metformin 500mg',
    'Penicillin',
    'Type 2 diabetes',
    'Annual physical checkup',
    'Yes everything is correct',
  ],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
