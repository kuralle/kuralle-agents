# @kuralle-agents/core

The runtime and primitives for building conversational AI agents — text and voice — with structured flows, routing, and durable tool execution.

## Install

```bash
npm install @kuralle-agents/core
```

Peers: `ai@^6 zod` and a provider, e.g. `@ai-sdk/openai`.

## What it does

One tagless primitive — `defineAgent` — derives behavior from the fields you populate: attach `flows` for structured node graphs, `routes` and `routing` for triage, or `agents` for composition. The runtime handles sessions, streaming, handoffs, and durable tool execution.

**Key exports:**

- **`defineAgent`** — define an agent; behavior is derived from which fields you set.
- **`defineFlow` + `reply` / `collect` / `action` / `decide`** — node-graph SOPs. Your procedure lives in typed code you can test.
- **`defineTool` + `buildToolSet`** — typed effect tools wired to both the model and the executor.
- **`createRuntime` / `Runtime`** — orchestrator: sessions, handoffs, streaming, flow state.
- **`MemoryStore`** — in-process `SessionStore`; swap for Redis or Postgres in production.

## Usage

```ts
import { createRuntime, defineAgent, defineTool, buildToolSet } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

const echo = defineTool({
  name: 'echo',
  description: 'Echo the input text',
  input: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ echoed: text }),
});

const agent = defineAgent({
  id: 'support',
  instructions: 'You are a helpful support agent.',
  model: openai('gpt-4o-mini'),
  tools: buildToolSet({ echo }),   // model-visible
  effectTools: { echo },           // durable executor
});

const runtime = createRuntime({ agents: [agent], defaultAgentId: 'support' });

const handle = runtime.run({ input: 'Hello', sessionId: 'demo' });
for await (const part of handle.events) {           // events is a property, not a method
  if (part.type === 'text-delta') process.stdout.write(part.delta);
  if (part.type === 'done') console.log('\nSession:', part.sessionId);
}
await handle;   // resolves to TurnResult once the stream is consumed
```

## Flows

A flow is a node graph that enforces a multi-step procedure without embedding a 600-line SOP in a system prompt.

```ts
import { defineAgent, defineFlow, collect, reply } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

const confirm = reply({
  id: 'confirm',
  instructions: 'Confirm the booking with the collected date, then end.',
  next: () => ({ end: 'done' }),
});

const getDate = collect({
  id: 'get_date',
  schema: z.object({ date: z.string() }),
  required: ['date'],
  instructions: (missing) => `Ask the user for: ${missing.join(', ')}`,
  onComplete: () => confirm,   // return the next node when the data is collected
});

const agent = defineAgent({
  id: 'booking',
  instructions: 'You are a booking agent.',
  model: openai('gpt-4o-mini'),
  flows: [
    defineFlow({
      name: 'booking',
      description: 'Book an appointment',
      start: getDate,
      nodes: [getDate, confirm],
    }),
  ],
});
```

Rule of thumb: if you're pasting more than ~20 lines of procedure into a system prompt, it belongs in a flow.

## Routing

```ts
const triage = defineAgent({
  id: 'triage',
  instructions: 'Route to the right specialist.',
  model: openai('gpt-4o-mini'),
  routes: [
    { agent: 'billing', when: 'billing question' },
    { agent: 'support', when: 'support request' },
  ],
  routing: { mode: 'structured', default: 'support' },
});
```

`mode: 'structured'` routes via schema — the routing decision never surfaces to the user.

## Sessions

`createRuntime` defaults to an in-process `MemoryStore`. Pass a `sessionStore` to use a durable backend:

```ts
import { createRuntime } from '@kuralle-agents/core';
import { RedisSessionStore } from '@kuralle-agents/redis-store';
import { createClient } from 'redis';

const client = createClient({ url: process.env.REDIS_URL });
await client.connect();

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'support',
  sessionStore: new RedisSessionStore({ client }),
});
```

## HTTP streaming

`TurnHandle` exposes `handle.toResponseStream('sse')` for HTTP transports — or use `@kuralle-agents/hono-server` for a ready-made Hono router.

## Related

- [`@kuralle-agents/hono-server`](https://www.npmjs.com/package/@kuralle-agents/hono-server) — HTTP/SSE/WebSocket router for Node.js or Bun.
- [`@kuralle-agents/cf-agent`](https://www.npmjs.com/package/@kuralle-agents/cf-agent) — Cloudflare Workers / Durable Objects integration.
- [`@kuralle-agents/redis-store`](https://www.npmjs.com/package/@kuralle-agents/redis-store) — Redis-backed session, memory, and vector store.
- [`@kuralle-agents/postgres-store`](https://www.npmjs.com/package/@kuralle-agents/postgres-store) — Postgres-backed session, memory, and vector store.
- [`@kuralle-agents/rag`](https://www.npmjs.com/package/@kuralle-agents/rag) — RAG primitives: chunkers, retrievers, vector stores.
