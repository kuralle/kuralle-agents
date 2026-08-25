import { openai } from '@ai-sdk/openai';
import { defineAgent, createRuntime } from '@kuralle-agents/core';

const model = openai('gpt-4o-mini');

const supportAgent = defineAgent({
  id: 'support',
  instructions: 'You handle product support requests.',
  model,
  // After the initial triage handoff, later turns stay on this agent. Give
  // each specialist routes to the other lanes so topic switches re-route
  // without returning to triage.
  routes: [{ agent: 'billing', when: 'billing question or payment issue' }],
  routing: { model },
});

const billingAgent = defineAgent({
  id: 'billing',
  instructions: 'You handle billing questions and payment issues.',
  model,
  routes: [{ agent: 'support', when: 'product support or general help' }],
  routing: { model },
});

const triage = defineAgent({
  id: 'triage',
  routes: [
    { agent: 'billing', when: 'billing question or payment issue' },
    { agent: 'support', when: 'product support or general help' },
  ],
  routing: { model },
  agents: [billingAgent, supportAgent],
});

const runtime = createRuntime({
  agents: [triage, billingAgent, supportAgent],
  defaultAgentId: 'triage',
  // A pure dispatcher declares no `model` of its own, and the runtime's model
  // gate reads `agent.model ?? defaultModel` — it does not fall back to
  // `routing.model`. Without this line every turn throws before classifying.
  defaultModel: model,
});
