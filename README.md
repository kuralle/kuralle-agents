# Kuralle

Kuralle is a TypeScript framework for building conversational AI agents with structured flows, routing, and durable tool execution.

## Why flows?

Most agent frameworks give you a prompt and a tool-call loop. That's fine until the conversation has steps — collect these fields, confirm, then book. Kuralle puts those steps in a **flow**: a small graph of typed nodes with real control flow, so your procedure lives in code you can test, not in a 600-line system prompt.

One tagless primitive (`defineAgent`) derives its behavior from the fields you set. Add `flows` to get a structured flow agent. Add `routes` to get a router. Add `agents` to compose them. The runtime, session management, and streaming stay the same across all three.

> Rule of thumb: if you're pasting more than ~20 lines of procedure into a system prompt, it belongs in a flow.

## Primitives

- **Agents** — `defineAgent` with instructions and tools. Behavior is derived from what you populate, not a type flag.
- **Flows** — node graphs (`reply`, `collect`, `action`, `decide`) where each node returns its next transition. Your SOP becomes a typed state machine you didn't have to hand-write.
- **Tools** — `defineTool` with a Zod input schema and an async executor. Every tool effect is logged so a retried turn never double-executes.
- **Routing / Handoffs** — model-reasoned routing (`routes`/`agents`, derived from agent shape) picks the right specialist without leaking dispatch text to the user. `handoffs` transfer session context between agents.
- **Runtime** — `createRuntime` wires agents, sessions, and streaming. Pi is the recommended application driver; Core keeps a portable AI SDK loop as its zero-configuration fallback. `runtime.run()` returns a `TurnHandle`: stream events with `handle.events`, await the result, pipe to HTTP with `handle.toUIMessageStreamResponse()` (AI SDK native, for `useChat`), or use `handle.toResponseStream('sse')` for raw `StreamPart` JSON-SSE.
- **Observability** — every run is captured as a structured `AgentTrace`. `runtime.runOnce()` returns one complete trace for evals; tracing is on by default (`MemoryTraceStore`), durable on Redis/Postgres/Cloudflare DO-SQLite, exportable to OTLP/Langfuse, and inspectable via `kuralle trace` or the embeddable `@kuralle-agents/trace-ui` viewer.

## Why Kuralle

**Procedures belong in flows, not prompts.** The form-filler example in `packages/core/examples/agents/form-filler.ts` replaces a 584-line v1 state machine with ~60 lines.

**Durable tool execution.** Every `defineTool` call is logged in an append-only effect log. Retries replay against the log — a payment tool doesn't charge twice, a booking tool doesn't double-book.

**Few primitives, composed.** `defineAgent`, `defineFlow`, `defineTool`, `createRuntime`. That's the core API. Routing, multi-agent composition, and session persistence are all derived from these.

## Installation

```bash
npm install @kuralle-agents/core @kuralle-agents/pi-driver @earendil-works/pi-ai @ai-sdk/openai ai zod
```

Peer dependencies: `ai@^6`, `zod`. Bring your own provider package (`@ai-sdk/openai`, `@ai-sdk/anthropic`, etc.).

## Your first agent

```ts
import { openai } from '@ai-sdk/openai';
import { createModels } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { PiDriver } from '@kuralle-agents/pi-driver';
import { z } from 'zod';
import { defineAgent, defineTool, createRuntime } from '@kuralle-agents/core';

const echo = defineTool({
  name: 'echo',
  description: 'Echo back the provided text',
  input: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ echoed: text }),
});

const agent = defineAgent({
  id: 'support',
  name: 'Support Agent',
  instructions: 'Helpful support agent. Use the echo tool when asked.',
  model: openai('gpt-4o-mini'),
  tools: { echo }, // model-visible and wired through the durable executor
});

const models = createModels();
models.setProvider(openaiProvider());
const piModel = models.getModel('openai', 'gpt-4o-mini');
if (!piModel) throw new Error('Pi model is not registered');

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'support',
  driver: new PiDriver({
    model: piModel,
    models,
    getApiKey: () => process.env.OPENAI_API_KEY,
  }),
});

let sessionId: string | undefined;

async function chat(input: string) {
  const handle = runtime.run({ input, sessionId });
  for await (const part of handle.events) {           // events is a property, not a method
    if (part.type === 'text-delta') process.stdout.write(part.payload.delta);
    if (part.type === 'done') sessionId = part.payload.sessionId;
  }
  await handle;
}

await chat('Use echo to say "hello"');
```

Run it:

```bash
OPENAI_API_KEY=sk-... npx tsx agent.ts
```

More examples: `packages/core/examples/agents/` — form-filler, transfer-agent, basic-chat, sales-with-leads.

> **Voice is out of scope.** Cascaded voice and telephony transports (LiveKit, WebSocket, SIP, Twilio, SmartPBX) live in **[kuralle/kuralle-livekit](https://github.com/kuralle/kuralle-livekit)**. Provider-native speech-to-speech has been removed from this repo; Kuralle is text-first. Inbound **voice notes** are still supported as multimodal audio input — see the Multimodal guide.

## Packages

| Package | Use when |
|---------|----------|
| [`@kuralle-agents/core`](https://www.npmjs.com/package/@kuralle-agents/core) | Always — agents, flows, runtime, session, tools, and the portable AI SDK fallback |
| [`@kuralle-agents/pi-driver`](https://www.npmjs.com/package/@kuralle-agents/pi-driver) | Recommended model/tool loop for production applications |
| [`@kuralle-agents/hono-server`](https://www.npmjs.com/package/@kuralle-agents/hono-server) | Serving agents over HTTP/SSE/WebSocket on Node.js or Bun |
| [`@kuralle-agents/cf-agent`](https://www.npmjs.com/package/@kuralle-agents/cf-agent) | Deploying to Cloudflare Workers with Durable Objects |
| [`@kuralle-agents/tools`](https://www.npmjs.com/package/@kuralle-agents/tools) | CAG tools for grounded retrieval and answering |
| [`@kuralle-agents/rag`](https://www.npmjs.com/package/@kuralle-agents/rag) | RAG primitives — knowledge sources, chunkers, retrieval |
| [`@kuralle-agents/redis-store`](https://www.npmjs.com/package/@kuralle-agents/redis-store) | Redis-backed session persistence (`RedisSessionStore`) |
| [`@kuralle-agents/trace-ui`](https://www.npmjs.com/package/@kuralle-agents/trace-ui) | Embeddable read-only trace waterfall and span detail viewer |
| [`@kuralle-agents/postgres-store`](https://www.npmjs.com/package/@kuralle-agents/postgres-store) | Postgres-backed session persistence |
| [`@kuralle-agents/cli`](https://www.npmjs.com/package/@kuralle-agents/cli) | `kuralle` CLI — interactive chat, adaptive send, simulation, trace inspection |

## Documentation

- [Documentation site](apps/docs) — guides, API reference, concepts
- [CONTRIBUTING.md](CONTRIBUTING.md) — monorepo dev setup, build, test, publish
- [CHANGELOG.md](CHANGELOG.md) — release history
- [LICENSE](LICENSE)
