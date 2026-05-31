# Transition Tools via `next` Handlers

## How flow transitions work in v2

In v2, transitions are **returned** from node handlers — not implicit tools from a separate edge table.

```ts
const appointments = reply({
  id: 'appointments',
  instructions: 'Help the user book an appointment.',
  next: () => ({ end: 'booked' }),
});

const triage = reply({
  id: 'triage',
  instructions: `CALL THESE TOOLS:
- appointments({}) when user wants to book
- services({}) when user asks about prices`,
  tools: buildToolSet({
    appointments: defineTool({
      name: 'appointments',
      description: 'User wants to book an appointment',
      input: z.object({}),
      execute: async () => ({ route: 'appointments' }),
    }),
    services: defineTool({
      name: 'services',
      description: 'User asks about services or pricing',
      input: z.object({}),
      execute: async () => ({ route: 'services' }),
    }),
  }),
  next: (turn) => {
    if (turn.toolResults.some((r) => r.name === 'appointments')) return appointments;
    if (turn.toolResults.some((r) => r.name === 'services')) return servicesNode;
    return 'stay';
  },
});
```

## How they work

1. **Tool registration**: Tools attach to `reply` nodes via `buildToolSet({ ... })`
2. **Execution**: `ChannelDriver.runAgentTurn` runs the LLM; model calls a tool
3. **Transition**: `next(turn, state)` inspects `turn.toolResults` and returns `{ goto, data }`, a node reference, or `'stay'`

## Critical learning: Don't duplicate

**WRONG:**
```ts
// Two paths to the same destination confuses the model
tools: buildToolSet({
  route_to_specialist: defineTool({ ... execute: () => ({ goto: 'appointments' }) }),
  appointments: defineTool({ ... }),
})
```

**RIGHT:**
```ts
// One tool per intent; next handler routes
tools: buildToolSet({ appointments: defineTool({ ... }) }),
next: (turn) => turn.toolResults.some((r) => r.name === 'appointments') ? appointmentsNode : 'stay',
```

## collect nodes handle their own loop

`collect` nodes run `collectUntilComplete` internally — no manual submit tool. Don't add a submit tool that duplicates what `onComplete` already does.

## Verification

Log tool calls and transitions from `TurnHandle` events:

```ts
const handle = runtime.run({ sessionId, input: 'I need to book' });
for await (const part of handle.events()) {
  if (part.type === 'tool-call') console.log('TOOL:', part.toolName);
  if (part.type === 'flow-transition') console.log('TRANSITION:', part);
}
```

Expected: `[tool-call] appointments` then `[flow-transition]` — not text-only deltas.
