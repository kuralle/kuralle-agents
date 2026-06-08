# Agents Guide

## One primitive: `defineAgent`

Behavior is **derived from field presence** — no agent type tag:

| You populate… | What the agent does |
|---------------|---------------------|
| `instructions` + `tools` | Free conversation with tools |
| `+ flows` | Runs intent-selected SOPs via `runFlow` |
| `+ routes` | Routes each turn — model-reasoned (silent dispatcher, or host-control tools) |
| `+ agents` / `handoffs` | Escalates or hands off to specialists |

Behavior derives from shape: routes/agents-only → silent pure dispatcher; answering surface → host-control tools + guard.

## Free conversation agent

```ts
import { defineAgent, defineTool, buildToolSet, createRuntime } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Lookup an order by id',
  input: z.object({ orderId: z.string() }),
  execute: async ({ orderId }) => ({ orderId, status: 'shipped' }),
});

const supportAgent = defineAgent({
  id: 'support',
  name: 'Support Agent',
  instructions: 'Be concise and helpful.',
  model: openai('gpt-4o-mini'),
  tools: { lookup_order: lookupOrder },
  handoffs: ['billing'],
});

const runtime = createRuntime({ agents: [supportAgent], defaultAgentId: 'support' });
```

## Flow agent (SOP)

```ts
import { defineAgent, defineFlow, reply, collect, buildToolSet, defineTool } from '@kuralle-agents/core';
import { z } from 'zod';

const ticketSchema = z.object({ summary: z.string().min(1) });

const createTicket = reply({
  id: 'create_ticket',
  instructions: 'Create a ticket from the collected summary.',
  next: () => ({ end: 'ticket_created' }),
});

const collectIssue = collect({
  id: 'collect_issue',
  schema: ticketSchema,
  required: ['summary'],
  instructions: () => 'Ask for a brief issue summary.',
  onComplete: () => createTicket,
});

const agent = defineAgent({
  id: 'support-flow',
  instructions: 'Follow SOP. Ask one question at a time.',
  model: openai('gpt-4o-mini'),
  flows: [
    defineFlow({
      name: 'support',
      description: 'Issue intake',
      start: collectIssue,
      nodes: [collectIssue, createTicket],
      hybrid: true,
    }),
  ],
});
```

## Routing agent

```ts
import { defineAgent } from '@kuralle-agents/core';

// No instructions/flows/tools → derives as a silent pure dispatcher.
const triageAgent = defineAgent({
  id: 'triage',
  model: openai('gpt-4o-mini'),
  routes: [
    { agent: 'support', when: 'Technical issues and bugs' },
    { agent: 'billing', when: 'Payments and account questions' },
  ],
  agents: [supportAgent, billingAgent],
});
```

Routing is model-reasoned and schema-only — no user-facing dispatch leaks.

## Sub-agent consultation via tools

Wrap specialist logic as a `defineTool` that another agent calls within one turn:

```ts
const weatherLookup = defineTool({
  name: 'consult_weather',
  description: 'Get current weather from a weather expert',
  input: z.object({ location: z.string() }),
  execute: async ({ location }) => weatherApi.forecast(location),
});

const leadAgent = defineAgent({
  id: 'lead',
  instructions: 'Use consult_weather when asked about weather.',
  model: openai('gpt-4o'),
  tools: { consult_weather: weatherLookup },
});
```

**When to use tool consultation vs handoffs:**
- Tool consultation — sub-task within one turn, no session handoff history
- `handoffs` — multi-turn orchestration with session tracking

## Defining agents

Define agents with `defineAgent` in TypeScript and pass them to `createRuntime`. The same `AgentConfig` runs on both `TextDriver` and `VoiceDriver`.
