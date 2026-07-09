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
- **`HarnessConfig.escalation` + `resumeFromEscalation`** — the human-handoff loop: handoff brief, handler, ownership claim (via engagement), resume-with-resolution.
- **`RunOptions.wake` + `Scheduler`** — agent-initiated turns (follow-ups, cart abandonment) on in-process timers or Cloudflare DO alarms (`@kuralle-agents/cf-agent`).
- **`HarnessConfig.compaction`** — automatic history summarization + context-overflow recovery for long-running threads.
- **`createFactMemoryService`** — cross-session fact memory (LLM merge-on-ingest) keyed by `userId` on any persistent block store.
- **Built-in guardrails** — `createPromptInjectionGuard`, `createPiiInputGuard`/`OutputGuard`, `createModerationGuard`, `createGroundingValidator` (see `guides/GUARDRAILS.md`).
- **Simulation eval** — `simulateConversation` + `createJudge` + `runSimulationSuite`: persona-driven simulated users scored by an LLM judge.
- **Pending-input drain-and-merge** — `setPendingUserInput` / `consumeAllPendingUserInput`: mid-turn messages enqueue; the next `awaitUser` drains the FIFO into one merged turn (pair with `@kuralle-agents/messaging` `inboundCoalescing` for WhatsApp bursts).

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
  tools: { echo },   // durable effect tools — model-visible AND executor-registered
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
  model: openai('gpt-4o-mini'),
  routes: [
    { agent: 'billing', when: 'billing question' },
    { agent: 'support', when: 'support request or anything else' },
  ],
});
```

With only `routes`/`agents` and no answering surface (no `instructions`/`flows`/`tools`), `triage` derives as a **pure dispatcher**: it silently classifies and routes. The decision is model-reasoned over the `when` descriptions and never surfaces to the user. Model every fallback as a normal route with a semantic `when` (e.g. "or anything else") — there is no `routing.default`. Optionally set `routing: { model }` to pick the control-reasoning model.

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

## HTTP streaming (web)

For React/web consumers, return a native AI SDK `UIMessageStream` — `useChat` works with no bridge:

```ts
const handle = runtime.run({ input: 'Hello', sessionId: 'demo' });
return handle.toUIMessageStreamResponse({ sessionId: 'demo' });
```

Kuralle orchestration events (flow telemetry, safety blocks, interactive choices) arrive as typed `data-kuralle-*` parts. Import `KuralleUIMessage` and `KuralleDataParts` for compile-time-safe `message.parts` and `useChat({ onData })` handlers.

For non-UI consumers (curl, custom transports), use `handle.toResponseStream('sse')` to emit raw `HarnessStreamPart` JSON-SSE. Or use `@kuralle-agents/hono-server` — `POST /api/chat/sse` defaults to native `UIMessageStream`; append `?format=raw` for the legacy wire.

## Related

- [`@kuralle-agents/hono-server`](https://www.npmjs.com/package/@kuralle-agents/hono-server) — HTTP/SSE/WebSocket router for Node.js or Bun.
- [`@kuralle-agents/cf-agent`](https://www.npmjs.com/package/@kuralle-agents/cf-agent) — Cloudflare Workers / Durable Objects integration.
- [`@kuralle-agents/redis-store`](https://www.npmjs.com/package/@kuralle-agents/redis-store) — Redis-backed session, memory, and vector store.
- [`@kuralle-agents/postgres-store`](https://www.npmjs.com/package/@kuralle-agents/postgres-store) — Postgres-backed session, memory, and vector store.
- [`@kuralle-agents/rag`](https://www.npmjs.com/package/@kuralle-agents/rag) — RAG primitives: chunkers, retrievers, vector stores.
