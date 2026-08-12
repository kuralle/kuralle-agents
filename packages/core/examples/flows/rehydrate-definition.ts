#!/usr/bin/env bun

import { createXai } from '@ai-sdk/xai';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import { rehydrateFlow, type FlowDefinition } from '../../src/flows/definition/index.js';
import { loadExampleEnv, requireLiveModel, runV2Conversation } from '../_shared/v2Runner.js';

loadExampleEnv(import.meta.url);

function exampleModel() {
  const xaiKey = process.env.XAI_API_KEY;
  if (xaiKey) {
    return { model: createXai({ apiKey: xaiKey })('grok-3'), label: 'xai:grok-3' };
  }
  return requireLiveModel();
}

const { model } = exampleModel();

const lookupAccount = defineTool({
  name: 'lookup_account',
  description: 'Look up an account by email and return eligibility status.',
  execute: async (args: unknown) => {
    const email = (args as { email?: string }).email ?? '';
    return { status: 'ok', id: 'acc-1', email };
  },
});

const notifyOps = defineTool({
  name: 'notify_ops',
  description: 'Notify operations about an ineligible account. Not used by this flow.',
  execute: async () => ({ sent: true }),
});

const tools = {
  lookup_account: lookupAccount,
  notify_ops: notifyOps,
};

const definition: FlowDefinition = {
  name: 'eligibility',
  description: 'Collect email and amount, look up the account, then reply from a template',
  start: 'intake',
  nodes: [
    {
      kind: 'collect',
      id: 'intake',
      schema: {
        type: 'object',
        properties: {
          email: { type: 'string' },
          amount: { type: 'number' },
        },
        required: ['email', 'amount'],
      },
      required: ['email', 'amount'],
      ask: 'What is your email and the amount you want to check?',
      instructions: 'Extract email and amount from the user. Call the submit tool when both are known.',
      assign: { 'state.email': 'email', 'state.amount': 'amount' },
      maxTurns: 6,
      next: { goto: 'lookup' },
    },
    {
      kind: 'action',
      id: 'lookup',
      tool: 'lookup_account',
      args: { email: { path: 'state.email' } },
      bind: 'state.account',
      next: { goto: 'route' },
    },
    {
      kind: 'decide',
      id: 'route',
      routes: [
        {
          when: { op: 'eq', left: { path: 'results.lookup.status' }, right: { literal: 'ok' } },
          to: { goto: 'ok' },
        },
      ],
      otherwise: { goto: 'blocked' },
    },
    {
      kind: 'reply',
      id: 'ok',
      response: {
        template: 'Account ${state.account.id} (${state.email}) is eligible for ${state.amount}.',
      },
      next: { end: 'eligible' },
    },
    {
      kind: 'reply',
      id: 'blocked',
      response: { template: 'Account ${state.email} is not eligible.' },
      next: { end: 'ineligible' },
    },
  ],
};

const eligibility = rehydrateFlow(definition, {
  tools: (id) => tools[id as keyof typeof tools],
});
eligibility.binding = true;

export const agent = defineAgent({
  id: 'rehydrate-definition',
  name: 'Rehydrated JSON flow',
  instructions: 'You collect an email and amount, then the flow looks up the account.',
  model,
  tools,
  flows: [eligibility],
});

export default agent;

if (import.meta.main) {
  runV2Conversation({
    title: 'Rehydrate FlowDefinition (collect → action → decide → template reply)',
    agent,
    model,
    prompts: ['Hi, I am ada@example.com and the amount is 40'],
    expectTerminal: true,
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
