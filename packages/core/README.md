# @kuralle-agents/core

The runtime and primitives for building conversational AI agents with structured flows, routing, and durable tool execution.

## Install

```bash
npm install @kuralle-agents/core
```

Peers: `ai@^6 zod` and a provider, e.g. `@ai-sdk/openai`.

Core includes a portable AI SDK channel loop so a minimal installation works on
Node 20, Bun, and workerd. For production agent applications, the recommended
driver is the companion `@kuralle-agents/pi-driver`; configure it once through
`HarnessConfig.driver`, and every normal, flow, wake, resume, Hono, and Cloudflare
entry point uses it. Pi stays in a companion package because it requires a Pi
provider model and Node 22.19 on Node, while Core cannot safely invent either.

## What it does

One tagless primitive — `defineAgent` — derives behavior from the fields you populate: attach `flows` for structured node graphs, `routes` and `routing` for triage, or `agents` for composition. The runtime handles sessions, streaming, handoffs, and durable tool execution.

**Key exports:**

- **`defineAgent`** — define an agent; behavior is derived from which fields you set.
- **`defineFlow` + `reply` / `collect` / `action` / `decide`** — node-graph SOPs. Your procedure lives in typed code you can test.
- **`FlowDefinition` + `validateFlowDefinition`** — the JSON flow dialect with a typed predicate DSL; validation returns machine-readable issues with repair actions.
- **`runtime.addDynamicFlows` / `removeDynamicFlow` / `loadDynamicFlows`** — register validated definitions on a live runtime, versioned in a `FlowDefinitionsStore` (`MemoryFlowDefinitionsStore` here; Postgres, Redis, and DO-SQLite backends in the store packages).
- **Durable flow runs** — `runtime.run({ kind: 'flow', flowName })` mints a journaled headless run; `recoverOrphanedRuns` / `sweepDeadlines` / `startRunSweeper` re-enter crashed replicas and expired deadlines.
- **`defineTool` + `buildToolSet`** — typed effect tools wired to both the model and the executor.
- **`defineSkill` + `AgentConfig.skills`** — progressively-disclosed procedural knowledge (`SKILL.md`-shaped): name+description always in the prompt, full body on `load_skill`, bundled resources on `read_skill_resource`. Four supply modes — inline, packaged directory, filesystem path, per-tenant resolver.
- **`createRuntime` / `Runtime`** — orchestrator: sessions, handoffs, streaming, flow state.
- **`MemoryStore`** — in-process `SessionStore`; swap for Redis or Postgres in production.
- **`HarnessConfig.escalation` + `resumeFromEscalation`** — the human-handoff loop: handoff brief, handler, ownership claim (via engagement), resume-with-resolution.
- **`RunOptions.wake` + `Scheduler`** — agent-initiated turns (follow-ups, cart abandonment) on in-process timers or Cloudflare DO alarms (`@kuralle-agents/cf-agent`).
- **`HarnessConfig.compaction`** — automatic history summarization + context-overflow recovery for long-running threads.
- **`factsExtractor()`** — built-in cross-session fact memory via `memory.extract`; merge-on-update with `includePrevious`, preload via `memory.preload`.
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
  if (part.type === 'text-delta') process.stdout.write(part.payload.delta);
  if (part.type === 'done') console.log('\nSession:', part.payload.sessionId);
}
await handle;   // resolves to TurnResult once the stream is consumed
```

## Single-run trace / `runOnce`

Use `runOnce` when an evaluator needs one complete, JSON-serializable turn instead
of a live stream. The trace includes the answer, tool roll-up, and nested spans.

```ts
const trace = await runtime.runOnce({
  sessionId: 'grounding-eval-42',
  input: 'What was my last invoice total?',
});

const judgeContext = {
  answer: trace.answer,
  evidence: trace.toolResults.map(({ name, result }) => ({ name, result })),
};

const verdict = await groundingJudge(judgeContext);
console.log(verdict, trace.usedTool, trace.traceId);
```

The root `turn` span records `attributes.ttftMs`, measured from trace creation to
the first non-empty client `text-delta`. This is client-observable TTFT: routing,
flow entry, and tool work performed before speech are intentionally included.

`runOnce` executes exactly one normal runtime turn and observes its existing event
stream. Runtime tracing also captures normal `run()` calls; trace persistence is
physically separate from the session store and durable effect journal.

## Observability

Tracing is enabled by default with an in-process `MemoryTraceStore`. Supply a native
store for durable reads and add any number of export sinks independently of
`sessionStore`:

```ts
import { createRuntime } from '@kuralle-agents/core';
import { RedisTraceStore } from '@kuralle-agents/redis-store';

const traceStore = new RedisTraceStore({
  client,
  traceTtlSeconds: 7 * 24 * 60 * 60,
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'support',
  tracing: {
    store: traceStore,
    sampling: 0.1,
    sinks: [externalSink],
    redact: (span) => ({
      ...span,
      attributes: { ...span.attributes, input: undefined, output: undefined },
    }),
  },
});

const latest = (await runtime.listTraces('session-42'))[0];
const trace = latest ? await runtime.getTrace(latest.traceId) : null;
```

Sink failures are swallowed and never change the run result. Redaction is off by
default for useful local debugging; use the hook above before persisting sensitive
tool inputs or outputs. Set `tracing.enabled: false` to disable capture.

### OTLP and Langfuse

The built-in exporter uses HTTP/JSON over `fetch`, so it runs in Bun, Node.js, and
Cloudflare Workers without a Node OpenTelemetry SDK:

```ts
import { langfuseSink, otelSink } from '@kuralle-agents/core';

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'support',
  tracing: {
    store: traceStore,
    sinks: [
      otelSink({ endpoint: 'https://collector.example.com', headers: { Authorization: 'Bearer token' } }),
      langfuseSink({ publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY }),
    ],
  },
});
```

Endpoints may include `/v1/traces`; otherwise the sink appends it. For self-hosted
Langfuse, pass its OTLP base URL as `endpoint`. Native span attributes, including
turn `ttftMs`, are exported with the `kuralle.` prefix (`kuralle.ttftMs`).

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

## Dynamic flows

A flow is also data. `FlowDefinition` is a JSON dialect — the same `reply` / `collect` / `action` / `decide` nodes, with transitions expressed in a typed predicate DSL. `validateFlowDefinition` returns machine-readable issues with repair actions, so a UI or an agent can fix a bad definition instead of guessing. Register definitions on a live runtime:

```ts
import { createRuntime, MemoryFlowDefinitionsStore } from '@kuralle-agents/core';

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'booking',
  flowDefinitionsStore: new MemoryFlowDefinitionsStore(),
});

await runtime.addDynamicFlows([bookingFlow], { agentId: 'booking' }); // validate + version + register
await runtime.loadDynamicFlows({ agentId: 'booking' });               // boot: reload active versions
```

The dialect also covers engine-rendered reply templates, collect `resolvers` (declarative slot extraction with a provenance guard), and per-flow verification `gates`. Definitions are versioned in a `FlowDefinitionsStore` — Memory here, `PostgresFlowDefinitionsStore`, `RedisFlowDefinitionsStore`, or the cf-agent `SqlFlowDefinitionsStore` in production. For LLM-authored flows, `createFlowBuilderAgent` + `FLOW_BUILDER_AUTHORING_PLAYBOOK` build definitions conversationally, and `compileNlPredicate` compiles natural-language `when: { nl }` predicates with pinned provenance. Examples: `examples/flows/rehydrate-definition.ts`, `examples/flows/dynamic-registration.ts`, `examples/flows/flow-builder.ts`. Depth: the [dynamic flows guide](https://agents.kuralle.com/guides/dynamic-flows).

## Durable flow runs

`runtime.run({ kind: 'flow', flowName })` mints a headless flow run whose steps journal to a `RunStore` (`HarnessConfig.runStore` — `PostgresRunStore`, or the cf-agent `SqlRunStore`). `handle.runId` resolves as soon as the run opens, before the turn body finishes, so the caller can persist the id it must resume with:

```ts
const handle = runtime.run({ input, sessionId, kind: 'flow', flowName: 'booking' });
const runId = await handle.runId;            // persist this
// after a crash or redeploy:
await runtime.run({ sessionId, runId });     // resumes from the journal
```

A replica holds an execution lease while it works a run. `recoverOrphanedRuns` re-enters `running` runs whose lease went stale, `sweepDeadlines` delivers the timeout outcome to `paused` runs past their deadline, and `startRunSweeper` schedules both. `RunStore.listRuns` / `deleteRun` cover operations.

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

## Skills

A skill is reusable procedural knowledge the model pulls in on demand — a tool executes, a skill teaches:

```ts
import { defineSkill } from '@kuralle-agents/core';

const returnsPolicy = defineSkill({
  name: 'returns-policy',
  description: 'Returns, refunds, and the 30-day window. Use when a customer asks about returning an order.',
  instructions: '1. Confirm the order id.\n2. If under 30 days old, it is returnable.',
  allowedTools: ['lookup_order'],
});

const agent = defineAgent({
  id: 'support',
  model: openai('gpt-4o-mini'),
  tools: { lookup_order: lookupOrder },
  skills: [returnsPolicy], // or a packaged directory, a workspace path, or a per-tenant resolver
});
```

Only `name` + `description` sit in every prompt; the full body loads via `load_skill` and bundled
resources via `read_skill_resource`, only when the model needs them. `allowedTools` is enforced at
the tool boundary once the skill activates — a guard-rail for an honest model, not an adversarial
boundary; see the [Skills guide](https://agents.kuralle.com/guides/skills) for the four supply
modes and the full frontmatter contract.

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

For non-UI consumers (curl, custom transports), use `handle.toResponseStream('sse')` to emit raw `StreamPart` JSON-SSE. Or use `@kuralle-agents/hono-server` — `POST /api/chat/sse` defaults to native `UIMessageStream`; append `?format=raw` for the legacy wire.

## Related

- [`@kuralle-agents/hono-server`](https://www.npmjs.com/package/@kuralle-agents/hono-server) — HTTP/SSE/WebSocket router for Node.js or Bun.
- [`@kuralle-agents/cf-agent`](https://www.npmjs.com/package/@kuralle-agents/cf-agent) — Cloudflare Workers / Durable Objects integration.
- [`@kuralle-agents/redis-store`](https://www.npmjs.com/package/@kuralle-agents/redis-store) — Redis-backed session, memory, and vector store.
- [`@kuralle-agents/postgres-store`](https://www.npmjs.com/package/@kuralle-agents/postgres-store) — Postgres-backed session, memory, and vector store.
- [`@kuralle-agents/rag`](https://www.npmjs.com/package/@kuralle-agents/rag) — RAG primitives: chunkers, retrievers, vector stores.
