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

// mode: 'structured' routes via schema — the routing decision never surfaces to the user
const triage = defineAgent({
  id: 'triage',
  instructions: 'Route the user to the right specialist.',
  model: openai('gpt-4o-mini'),
  routes: [
    { agent: 'billing', when: 'billing question or payment issue' },
    { agent: 'support', when: 'product support request' },
  ],
  routing: { mode: 'structured', default: 'support' },
});

const runtime = createRuntime({
  agents: [triage, billingAgent, supportAgent],
  defaultAgentId: 'triage',
});
