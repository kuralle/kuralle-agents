# Advanced Flow Techniques

## routing.model — use a fast control model for routing

`routing.model` sets the model used on the host control path — the lazy guard (answering agents, empty turns only) and the pure-dispatcher classifier. Using a smaller, faster model there cuts routing latency without quality loss; it does not affect the speaking model.

```ts
import { defineAgent, defineFlow, reply } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';

const agent = defineAgent({
  id: 'claims',
  model: openai('gpt-4o-mini'),
  routing: { model: openai('gpt-4o-mini') }, // fast classification
  flows: [defineFlow({
    name: 'claims',
    description: 'Insurance claims intake',
    start: intakeNode,
    nodes: [intakeNode],
  })],
});
```

Set `routing.model` to the cheapest/fastest model that can reliably distinguish on-topic vs off-topic messages.

## relevantFields — token efficiency for deep flows

Collected flow state is available in `instructions` via `({ state })`. Reference only the fields each node needs:

```ts
reply({
  id: 'collect_vehicle',
  instructions: ({ state }) =>
    `Collect vehicle details for ${state.holderName}. Incident date: ${state.incidentDate}.`,
});
```

Other fields remain in flow state for later nodes — they're just not injected into the prompt.

## Typed schemas on collect nodes

Validate collected data at node boundaries via Standard Schema on `collect`:

```ts
collect({
  id: 'review_prep',
  schema: z.object({
    holderName: z.string(),
    policyNumber: z.string(),
    incidentDate: z.string(),
  }),
  required: ['holderName', 'policyNumber', 'incidentDate'],
  onComplete: () => reviewNode,
});
```

If required fields are missing when the node completes, `collectUntilComplete` keeps prompting.

## Flow metrics

Wire hooks to capture per-node timing:

```ts
import { createRuntime } from '@kuralle-agents/core';

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: agent.id,
  hooks: {
    onStreamPart: async (ctx, part) => {
      if (part.type === 'node-enter') console.log('Node:', part.nodeId);
    },
  },
});
```

Stream events include `node-enter`, `node-exit`, `flow-transition`, `flow-end`.

## contextStrategy: reset_with_summary (warm transfer)

Clears conversation history and injects an LLM-generated summary when entering a node:

```ts
reply({
  id: 'human_briefing',
  instructions: 'Summarize what the customer needs for the human agent.',
  context: 'reset_with_summary',
});
```

When the flow transitions to this node, the runtime generates a summary, clears message history, and injects the briefing.

## action nodes for deterministic steps

Run side effects without an LLM call:

```ts
action({
  id: 'transferring',
  run: async (state, ctx) => {
    await ctx.tool('start_transfer', { patientId: state.patientId });
    return { goto: endNode };
  },
});
```

| Node kind | Purpose |
|-----------|---------|
| `reply` | LLM turn + optional tools |
| `collect` | Multi-turn schema gather |
| `action` | Deterministic step via `ctx.tool` |
| `decide` | Structured branch |

