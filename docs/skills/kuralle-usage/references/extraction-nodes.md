# Collect Nodes (Structured Extraction)

A `collect` node gathers structured data from the user across multiple turns using a Standard Schema — no manual submit-tool wiring required. The node loops until all required fields pass validation, then auto-transitions via `onComplete`.

## When to use

Use `collect` nodes instead of manually defined collection tools when:
- You need to collect multiple fields (name, phone, reason, date) from a single conversation
- The user might provide fields out of order or across turns
- You want auto-transition when collection is complete without a dedicated submit tool

## Define the schema

```ts
import { z } from 'zod';

const contactSchema = z.object({
  name: z.string().min(1),
  phone: z.string().min(7),
  reason: z.string().min(1),
});
```

## Add to a flow

```ts
import {
  defineAgent, defineFlow, collect, reply, defineTool, buildToolSet, createRuntime,
} from '@kuralle-agents/core';

const confirm = reply({
  id: 'confirm',
  instructions: ({ state }) =>
    `Review with the caller: ${state.name}, ${state.phone}, reason: ${state.reason}. Ask if correct.`,
  next: () => ({ end: 'confirmed' }),
});

const collectInfo = collect({
  id: 'collect_info',
  schema: contactSchema,
  required: ['name', 'phone', 'reason'],
  maxTurns: 8,
  instructions: () => 'Collect contact information. Ask naturally — one field at a time.',
  onComplete: (data) => ({ goto: confirm, data: data as Record<string, unknown> }),
});

const greeting = reply({
  id: 'greeting',
  instructions: 'Welcome the caller and start collecting contact info.',
  tools: buildToolSet({
    start_collection: defineTool({
      name: 'start_collection',
      description: 'Begin collecting contact info',
      input: z.object({}),
      execute: async () => ({ start: true }),
    }),
  }),
  next: (turn) =>
    turn.toolResults.some((r) => r.name === 'start_collection') ? collectInfo : 'stay',
});

const agent = defineAgent({
  id: 'receptionist',
  instructions: 'You are a friendly receptionist.',
  model: openai('gpt-4o-mini'),
  flows: [
    defineFlow({
      name: 'intake',
      description: 'Collect contact info',
      start: greeting,
      nodes: [greeting, collectInfo, confirm],
    }),
  ],
});

const runtime = createRuntime({ agents: [agent], defaultAgentId: agent.id });
```

## Key properties

| Field | Description |
|-------|-------------|
| `schema` | Standard Schema defining collected fields |
| `required` | Subset of fields that must be present before auto-transition |
| `maxTurns` | Safety limit before error/transition (default: 10) |
| `onComplete` | Returns transition when all required fields collected |
| `instructions` | Prompt for missing fields: `(missing, state) => string` |

## Template variables in later nodes

Collected data merges into flow state and is available in downstream `instructions`:

```ts
reply({
  id: 'confirm',
  instructions: ({ state }) => `Confirm with ${state.name} at ${state.phone}.`,
});
```

## Carry-forward between collect nodes

When a flow transitions between `collect` nodes, previously collected data carries forward automatically. If the user provides data for the next node's schema in the same message, it is captured immediately.

## Voice: extractionModel is required

In voice mode, the primary audio model can hallucinate extracted slots. Set `extractionModel` on `createRuntime` to verify against the actual user transcript post-turn:

```ts
import { openai } from '@ai-sdk/openai';

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: agent.id,
  extractionModel: openai('gpt-4o-mini'),
  voiceMode: true,
});
```

See `docs/skills/kuralle-voice-agents/rules/extraction-model-required.md` for why this is critical.

## Run the demo

```bash
cd packages/core
npx tsx examples/flows/extraction-node-demo.ts
# Requires OPENAI_API_KEY
```
