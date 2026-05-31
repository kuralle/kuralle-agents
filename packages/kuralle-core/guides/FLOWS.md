# Flows Guide

Flows provide structured, multi-step conversations using `defineFlow`, node builders (`reply`, `collect`, `decide`, `action`), and tool-driven transitions.

## Flow agents

Attach one or more flows to an agent via `defineAgent({ flows: [...] })`. The `Runtime` runs the active flow and emits `node-enter`, `flow-transition`, and `flow-end` events on the turn stream.

Key features:
- Node builders: `reply`, `collect`, `decide`, `action`
- Tool-driven transitions via `createFlowTransition()` (AI SDK tools) or `next` callbacks on `reply` nodes
- Hybrid mode (`hybrid: true` on `defineFlow`) to answer off-topic questions and resume the flow

## Minimal flow example

See `examples/flows/restaurant-reservation.ts` for a full runnable example. Sketch:

```ts
import { z } from 'zod';
import { defineAgent, defineFlow, defineTool, reply, createRuntime } from '@kuralle-agents/core';

const collectDate = defineTool({
  name: 'collect_date',
  description: 'Capture booking date',
  input: z.object({ date: z.string() }),
  execute: async ({ date }) => ({ date }),
});

const greeting = reply({
  id: 'greeting',
  instructions: 'Welcome. What date would you like to book?',
  tools: { collect_date: collectDate }, // wire via effectTools + ToolSet in production
  next: (turn) => {
    const r = turn.toolResults.find((t) => t.name === 'collect_date');
    return r?.result ? { goto: confirm, data: r.result as Record<string, unknown> } : 'stay';
  },
});

const confirm = reply({
  id: 'confirm',
  instructions: 'Confirm the booking.',
  next: () => ({ end: 'booked' }),
});

const agent = defineAgent({
  id: 'booking',
  instructions: 'You are a booking assistant.',
  model,
  effectTools: { collect_date: collectDate },
  flows: [
    defineFlow({
      name: 'booking',
      start: greeting,
      nodes: [greeting, confirm],
      hybrid: true,
    }),
  ],
});

const runtime = createRuntime({ agents: [agent], defaultAgentId: 'booking' });
const handle = runtime.run({ input: 'Hi', sessionId: 'demo' });
for await (const part of handle.events) {
  if (part.type === 'text-delta') process.stdout.write(part.text);
}
await handle;
```

## AI SDK transition tools

For tools that return `createFlowTransition(targetId, data)`, the runtime interprets the transition from the tool result. Use this when you keep tools on the AI SDK `tool()` shape.

## Transition tips

- Return `createFlowTransition(targetId, data)` from tool `execute` handlers that move the flow.
- On `reply` nodes, return `{ goto: nextNode, data }` from `next` when a tool result is ready.
- Use `createFlowUpdate(data, text, keys)` to merge state without leaving the node.
- Set `hybrid: true` on the flow when the agent should answer off-script questions between steps.
