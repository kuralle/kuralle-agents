import { openai } from '@ai-sdk/openai';
import { defineAgent, createRuntime } from '@kuralle-agents/core';

const billingAgent = defineAgent({
  id: 'billing',
  instructions: 'You handle billing questions and payment issues.',
  model: openai('gpt-4o-mini'),
});

const supportAgent = defineAgent({
  id: 'support',
  instructions: 'You handle product support requests.',
  model: openai('gpt-4o-mini'),
});

const triage = defineAgent({
  id: 'triage',
  routes: [
    { agent: 'billing', when: 'billing question or payment issue' },
    { agent: 'support', when: 'product support or general help' },
  ],
  routing: { model: openai('gpt-4o-mini') },
});

const runtime = createRuntime({
  agents: [triage, billingAgent, supportAgent],
  defaultAgentId: 'triage',
});
