# Core Package (80/20)

## What it is

`@kuralle-agents/core` is the runtime + agent primitives + flows + session + hooks + guards. It is the spine of Kuralle.

## What you use most

- `createRuntime` / `Runtime` — multi-agent harness
- `defineAgent` — single agent primitive (behavior derived from fields)
- `defineFlow`, `reply`, `collect`, `action`, `decide` — flow node kinds
- `defineTool`, `buildToolSet`, `tools` — durable tool execution
- `runFlow`, `hostLoop` — flow dispatch and turn composition
- `TurnHandle` — await result, iterate events, pipe to response stream
- `TextDriver` — channel driver
- hooks + guardrails

## Minimal runtime example

```ts
import { createRuntime } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';

const runtime = createRuntime({
  agents: [supportAgent],
  defaultAgentId: 'support',
  defaultModel: openai('gpt-4o-mini'),
});
```

## Run a turn

```ts
const handle = runtime.run({ input: 'Hi', sessionId });
for await (const part of handle.events) {
  if (part.type === 'text-delta') process.stdout.write(part.payload.delta);
}
const result = await handle;
```

## Flows (SOP)

Use `flows` on `defineAgent` when you need determinism. Node handlers return transitions:

```ts
const next = reply({
  id: 'next',
  instructions: 'Proceed.',
  next: (turn) =>
    turn.toolResults.some((r) => r.name === 'advance')
      ? { goto: confirmNode.id, data: turn.toolResults[0].result as Record<string, unknown> }
      : 'stay',
});
```

`defineFlow` validates the graph and **throws** on duplicate ids, unresolvable transitions, and unreachable nodes. Transition targets must be registered nodes (the same object in `flow.nodes`) or `{ goto: '<id>' }` — inline node objects and transition thunks are rejected. Flows also exist as data: the `FlowDefinition` JSON dialect with `validateFlowDefinition` and live registration via `runtime.addDynamicFlows` (`references/flow-definitions.md`).

## Routing

An agent with `routes`/`agents` and no answering surface (no `instructions`/`flows`/`tools`) derives as a **silent pure dispatcher** — it classifies and routes without leaking text:

```ts
const agent = defineAgent({
  id: 'router',
  routes: [{ agent: 'support', when: 'General support or anything else' }],
  agents: [supportAgent],
});
```

## Hooks + guards

- Hooks on `createRuntime({ hooks })` or per-agent `hooks`
- Guardrails via `agent.guardrails.input` / `agent.guardrails.output`

## Where to read more

- `node_modules/@kuralle-agents/core/README.md`
- `docs/skills/kuralle-usage/references/runtime.md`
