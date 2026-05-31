#!/usr/bin/env bun

import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { defineFlow, reply } from '../../src/authoring/nodes.js';
import { buildToolSet, defineTool } from '../../src/tools/effect/defineTool.js';
import { loadExampleEnv, requireLiveModel, runV2Conversation } from '../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);
const { model } = requireLiveModel();

const INSURANCE_RATES = {
  young_single: { base_rate: 150, risk_multiplier: 1.5 },
  young_married: { base_rate: 130, risk_multiplier: 1.3 },
  adult_single: { base_rate: 100, risk_multiplier: 1.0 },
  adult_married: { base_rate: 90, risk_multiplier: 0.9 },
} as const;

function calculateQuote(age: number, maritalStatus: 'single' | 'married') {
  const ageCategory = age < 25 ? 'young' : 'adult';
  const key = `${ageCategory}_${maritalStatus}` as keyof typeof INSURANCE_RATES;
  const rates = INSURANCE_RATES[key] ?? INSURANCE_RATES.adult_single;
  const monthly_premium = rates.base_rate * rates.risk_multiplier;
  return {
    monthly_premium,
    monthly_premium_display: monthly_premium.toFixed(2),
    coverage_amount: 250000,
    deductible: 1000,
  };
}

function updateCoverage(coverageAmount: number, deductible: number) {
  let monthly_premium = (coverageAmount / 250000) * 100;
  if (deductible > 1000) monthly_premium *= 0.9;
  return {
    monthly_premium,
    monthly_premium_display: monthly_premium.toFixed(2),
    coverage_amount: coverageAmount,
    deductible,
  };
}

const roleMessage =
  'You are a friendly insurance agent. Your responses will be converted to audio, so avoid special characters. Always use the available functions to progress the conversation naturally.';

const end = reply({
  id: 'end',
  instructions:
    'Thank the customer for their time and end the conversation. Mention that a representative will contact them about the quote.',
  model,
  next: () => ({ end: 'quote_completed' }),
});

const quoteResults = reply({
  id: 'quote_results',
  instructions: ({ state }) =>
    [
      'Quote details:',
      `Monthly Premium: $${state.monthly_premium_display ?? '?'}`,
      `Coverage Amount: $${state.coverage_amount ?? '?'}`,
      `Deductible: $${state.deductible ?? '?'}`,
      '',
      "Explain these quote details to the customer. When they request changes, use update_coverage to recalculate their quote. Explain how their changes affected the premium and compare it to their previous quote. Ask if they'd like to make any other adjustments or if they're ready to end the quote process.",
      '',
      'IMPORTANT: Do NOT call update_coverage and end_quote in the same turn. Either adjust the quote OR end it — not both.',
    ].join('\n'),
  model,
  tools: buildToolSet({
    update_coverage: defineTool({
      name: 'update_coverage',
      description: 'Recalculate quote with new coverage options',
      input: z.object({ coverage_amount: z.number().int(), deductible: z.number().int() }),
      execute: async ({ coverage_amount, deductible }, ctx) => {
        const quote = updateCoverage(coverage_amount, deductible);
        Object.assign(ctx!.runState.state, quote);
        return quote;
      },
    }),
    end_quote: defineTool({
      name: 'end_quote',
      description: 'Complete the quote process when customer is satisfied',
      input: z.object({}),
      execute: async () => ({ done: true }),
    }),
  }),
  next: (turn) => {
    if (turn.toolResults.some((r) => r.name === 'end_quote')) return end;
    if (turn.toolResults.some((r) => r.name === 'update_coverage')) return 'stay';
    return 'stay';
  },
});

const quoteCalculation = reply({
  id: 'quote_calculation',
  instructions: ({ state }) =>
    `Calculate a quote for ${state.age} year old ${state.marital_status} customer. First, call calculate_quote with their information. Then explain the quote details and ask if they'd like to adjust coverage.`,
  model,
  tools: buildToolSet({
    calculate_quote: defineTool({
      name: 'calculate_quote',
      description: 'Calculate initial insurance quote',
      input: z.object({
        age: z.number().int(),
        marital_status: z.enum(['single', 'married']),
      }),
      execute: async ({ age, marital_status }) => ({ age, marital_status, ...calculateQuote(age, marital_status) }),
    }),
  }),
  next: (turn) => {
    const r = turn.toolResults.find((t) => t.name === 'calculate_quote');
    if (r?.result) return { goto: quoteResults, data: r.result as Record<string, unknown> };
    return 'stay';
  },
});

const maritalStatus = reply({
  id: 'marital_status',
  instructions: "Ask about the customer's marital status for premium calculation.",
  model,
  tools: buildToolSet({
    collect_marital_status: defineTool({
      name: 'collect_marital_status',
      description: 'Record marital status after customer provides it',
      input: z.object({ marital_status: z.enum(['single', 'married']) }),
      execute: async ({ marital_status }, ctx) => ({
        age: ctx!.runState.state.age,
        marital_status,
      }),
    }),
  }),
  next: (turn) => {
    const r = turn.toolResults.find((t) => t.name === 'collect_marital_status');
    if (r?.result) return { goto: quoteCalculation, data: r.result as Record<string, unknown> };
    return 'stay';
  },
});

const initial = reply({
  id: 'initial',
  instructions: `${roleMessage}\n\nStart by asking for the customer's age.`,
  model,
  tools: buildToolSet({
    collect_age: defineTool({
      name: 'collect_age',
      description: "Record customer's age",
      input: z.object({ age: z.number().int() }),
      execute: async ({ age }) => ({ age }),
    }),
  }),
  next: (turn) => {
    const r = turn.toolResults.find((t) => t.name === 'collect_age');
    if (r?.result) return { goto: maritalStatus, data: r.result as Record<string, unknown> };
    return 'stay';
  },
});

const agent = defineAgent({
  id: 'insurance-quote-flow',
  name: 'Insurance Quote (Pipecat parity)',
  instructions: roleMessage,
  model,
  limits: { toolMaxSteps: 1 },
  flows: [
    defineFlow({
      name: 'quote',
      description: 'Insurance quote flow',
      start: initial,
      nodes: [initial, maritalStatus, quoteCalculation, quoteResults, end],
      maxOscillations: 10,
    }),
  ],
});

runV2Conversation({
  title: 'Pipecat Insurance Quote (v2)',
  agent,
  prompts: ['Hi, I need a quote.', 'I am 28.', 'Married.', 'Can we change to 500000 coverage and 2000 deductible?', 'Looks good. End quote.'],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
