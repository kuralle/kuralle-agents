# Runtime-in-Code Guide

**Note:** This guide covers the **code-first** approach using Runtime directly in TypeScript. For **config-first** approach (quick start), see `quickstart.md` and `config-pack.md`.

## Contents

- Why runtime-in-code
- Minimal runtime setup
- Streaming loop
- Hooks and tracing
- Auto-retrieve wiring
- Structured triage wiring

## Why runtime-in-code

Use this when you need:
- Custom wiring or orchestration
- Custom tool routing logic
- Dynamic agent creation
- Full TypeScript type safety
- Custom runtime hooks or behavior

## Minimal runtime

```ts
import { Runtime } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';

const runtime = new Runtime({
  agents: [supportAgent],
  defaultAgentId: 'support',
  defaultModel: openai('gpt-4o-mini') as any,
});
```

## Streaming loop

```ts
let sessionId: string | undefined;
for await (const part of runtime.stream({ input: 'Hello', sessionId })) {
  if (part.type === 'text-delta') process.stdout.write(part.delta);
  if (part.type === 'done') sessionId = part.sessionId;
}
```

## Hooks + tracing

If you need observability, add hooks in the Runtime config:

```ts
const runtime = new Runtime({
  agents: [supportAgent],
  defaultAgentId: 'support',
  defaultModel: openai('gpt-4o-mini') as any,
  hooks: {
    onStreamPart: async (ctx, part) => {
      if (part.type === 'error') console.error(part.error);
    },
  },
});
```

## Auto-retrieve (agent-level)

```ts
const supportAgent = {
  id: 'support',
  name: 'Support',
  instructions: 'Be concise and helpful.',
  autoRetrieve: {
    toolName: 'cag_retrieve',
    run: async ({ input }) => ({ text: `Relevant context for: ${input}` }),
  },
};

const runtime = new Runtime({
  agents: [supportAgent],
  defaultAgentId: 'support',
  defaultModel: openai('gpt-4o-mini') as any,
});
```

## Structured triage

```ts
const triageAgent = {
  id: 'triage',
  name: 'Triage',
  triageMode: 'structured',
  instructions: 'Route to the correct specialist.',
  routes: [
    { agentId: 'support', description: 'General support issues' },
  ],
};

const runtime = new Runtime({
  agents: [triageAgent, supportAgent],
  defaultAgentId: 'support',
  defaultModel: openai('gpt-4o-mini') as any,
  triageAgentId: 'triage',
  alwaysRouteThroughTriage: true,
});
```

## Tips

- Keep triage output schema strict and short.
- If triage leaks, enforce structured mode and block triage text output.
- Use `prompt` (not `instructions`) and `parameters` (not `inputSchema`) in all agent/tool definitions.

## Session caching (high-throughput)

In-memory LRU cache reduces store lookups for the same session within a process:

```ts
const runtime = new Runtime({
  agents,
  sessionStore: postgresStore,
  sessionCache: { maxEntries: 100, ttlMs: 30_000 }, // 30s TTL
});
```

## Deferred persistence (lower perceived latency)

`done` event fires before the session save completes:

```ts
const runtime = new Runtime({
  agents,
  deferPersistence: true, // done fires immediately; save runs in background
});
```

Only use if you can tolerate the session not being fully persisted when the client receives `done`.

## Abort in-flight stream (human takeover)

Kill an LLM stream mid-generation — used in human agent takeover patterns:

```ts
runtime.abortSession(sessionId, 'Human agent taking over');
// Fires AbortController signal → terminates streamText() in Runtime
// Session is saved with whatever was generated up to that point
```

## Read session state outside stream

```ts
const session = await runtime.getSession(sessionId);
if (session?.workingMemory['mode'] === 'human') {
  // forward to operator inbox instead of calling runtime.stream()
}
```

## workingMemory patterns

Store transient state that should surface in the LLM's context but not appear as chat messages:

```ts
// Set in a hook or API endpoint
session.workingMemory['mode'] = 'human';           // human takeover flag
session.workingMemory['handoffSummary'] = '...';   // injected into next LLM turn
session.workingMemory['riskLevel'] = 'high';       // flag visible to all agents
await runtime.sessionStore.save(session);
```

Working memory is merged into the system prompt on the next `stream()` call.
