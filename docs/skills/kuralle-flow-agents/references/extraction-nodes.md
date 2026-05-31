# Collect Nodes in Flow Agents

A `collect` node gathers structured fields from the user across turns using a Standard Schema. No manual submit tool required — it loops until all required fields pass validation, then auto-transitions via `onComplete`.

## When to use collect nodes

Use `collect` instead of manually building collection tools when:
- You need to collect 2+ fields naturally from conversation (name, phone, reason)
- The user might provide fields in any order or across multiple turns
- You want auto-transition when all fields are collected

## Basic setup

```ts
import { z } from 'zod';
import { defineAgent, defineFlow, collect, reply, defineTool, buildToolSet } from '@kuralle-agents/core';

const confirm = reply({
  id: 'confirm',
  instructions: ({ state }) => `Confirm with ${state.name} at ${state.phone}. Ask if correct.`,
  next: () => ({ end: 'confirmed' }),
});

const collectInfo = collect({
  id: 'collect_info',
  schema: z.object({
    name: z.string().min(1),
    phone: z.string().min(7),
  }),
  required: ['name', 'phone'],
  maxTurns: 8,
  instructions: () => 'Collect contact information. Ask naturally, one field at a time.',
  onComplete: (data) => ({ goto: confirm, data: data as Record<string, unknown> }),
});

const greeting = reply({
  id: 'greeting',
  instructions: 'Welcome the caller.',
  tools: buildToolSet({
    start: defineTool({
      name: 'start',
      description: 'Begin collecting contact info',
      input: z.object({}),
      execute: async () => ({ start: true }),
    }),
  }),
  next: (turn) => (turn.toolResults.some((r) => r.name === 'start') ? collectInfo : 'stay'),
});

const agent = defineAgent({
  id: 'receptionist',
  flows: [
    defineFlow({
      name: 'intake',
      description: 'Contact collection',
      start: greeting,
      nodes: [greeting, collectInfo, confirm],
    }),
  ],
});
```

## Per-field instructions

The `instructions` callback receives missing fields:

```ts
collect({
  id: 'collect_info',
  schema: z.object({ name: z.string(), phone: z.string() }),
  required: ['name', 'phone'],
  instructions: (missing) =>
    missing.includes('name')
      ? 'What is your full name?'
      : 'What is your phone number?',
  onComplete: () => confirm,
});
```

## Template variables in later nodes

Collected fields are available in downstream `instructions` via `state`:

```ts
reply({
  id: 'confirm',
  instructions: ({ state }) => `I have ${state.name} at ${state.phone}. Is that correct?`,
});
```

## Don't duplicate submit tools

`collect` runs `collectUntilComplete` internally. **Don't add a manual submit tool** — it will conflict with the built-in extraction loop.

## CollectNode fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schema` | Standard Schema | Yes | Schema defining collected fields |
| `required` | `string[]` | No | Fields that must be present before transition |
| `maxTurns` | `number` | No | Safety limit (default: 10) |
| `onComplete` | `(data, state) => Transition` | Yes | Transition when collection complete |
| `instructions` | `(missing, state) => Instructions` | No | Prompt for missing fields |

## Voice mode

In voice, the primary audio model can hallucinate extracted slots. Always set `extractionModel` on `createRuntime`:

```ts
import { createRuntime } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: agent.id,
  extractionModel: openai('gpt-4o-mini'),
  voiceMode: true,
});
```

See `docs/skills/kuralle-voice-agents/rules/extraction-model-required.md`.
