# @kuralle-agents/redis-store

Redis-backed session, flow-definition, memory, trace, and vector stores for Kuralle.

## Install

```bash
npm install @kuralle-agents/redis-store
```

Peers: `@kuralle-agents/core @kuralle-agents/rag`.

## What it does

Backend implementations for sessions, dynamic flow definitions, long-term memory, traces, and vector search — all backed by Redis. Works with Upstash, node-redis, ioredis, or any client that exposes compatible `get` / `set` / `del` commands.

**Key exports:**

- **`RedisSessionStore`** — `SessionStore` implementation for durable session persistence.
- **`RedisTraceStore`** — independent native trace persistence and read API.
- **`RedisFlowDefinitionsStore`** — versioned `FlowDefinitionsStore` for dynamic `FlowDefinition`s.
- **`RedisExtractedValueStore`** — durable store for extractor output (cross-session memory).
- **`RedisPersistentMemoryStore`** — `PersistentMemoryStore` for durable USER/MEMORY markdown blocks.
- **`RedisVectorStore`** — `VectorStoreCore` implementation for vector similarity search.
- **`fromUpstash` / `fromNodeRedis` / `fromIORedis`** — client adapters.

## Session store

```ts
import { createRuntime } from '@kuralle-agents/core';
import { RedisSessionStore, fromUpstash } from '@kuralle-agents/redis-store';
import { Redis } from '@upstash/redis';

const sessionStore = fromUpstash(Redis.fromEnv(), { prefix: 'kuralle' });

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'support',
  sessionStore,
});
```

## Trace store

```ts
import { RedisTraceStore } from '@kuralle-agents/redis-store';

const traceStore = new RedisTraceStore({ client, traceTtlSeconds: 604800 });
const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'support',
  tracing: { store: traceStore },
});
```

Trace keys use a separate `trace`/`traces` namespace from sessions.

## Flow definitions store

Versioned storage for dynamic `FlowDefinition`s — the backend for `runtime.addDynamicFlows` / `loadDynamicFlows`:

```ts
import { createRuntime } from '@kuralle-agents/core';
import { RedisFlowDefinitionsStore } from '@kuralle-agents/redis-store';

const flowDefinitionsStore = new RedisFlowDefinitionsStore({ client, prefix: 'kuralle' });

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'support',
  flowDefinitionsStore,
});

await runtime.loadDynamicFlows({ agentId: 'support' });   // boot: reload active versions
```

Keys live under `<prefix>:flowdef:*`. Any compatible client works, including the Upstash REST client on Cloudflare Workers. See the [dynamic flows guide](https://agents.kuralle.com/guides/dynamic-flows).

## Client adapters

**node-redis:**

```ts
import { createClient } from 'redis';
import { fromNodeRedis } from '@kuralle-agents/redis-store';

const client = createClient({ url: process.env.REDIS_URL });
await client.connect();
const sessionStore = fromNodeRedis(client, { prefix: 'kuralle' });
```

**ioredis:**

```ts
import Redis from 'ioredis';
import { fromIORedis } from '@kuralle-agents/redis-store';

const client = new Redis(process.env.REDIS_URL);
const sessionStore = fromIORedis(client, { prefix: 'kuralle' });
```

**Direct constructor** (any compatible client):

```ts
import { RedisSessionStore } from '@kuralle-agents/redis-store';

const sessionStore = new RedisSessionStore({ client: myClient, prefix: 'kuralle' });
```

## Store options

- `prefix` (default: `'kuralle'`) — key namespace.
- `sessionTtlSeconds` — optional TTL for session keys.
- `enableCleanupIndex` (default: `true`) — maintain a sorted set for cleanup by `updatedAt`.

## Long-term memory

Cross-session memory is configured on the **agent**, not the runtime. Extractors
decide what is worth keeping; `preload` puts the relevant parts back into the next
session's prompt.

```ts
import { defineAgent, createRuntime, factsExtractor } from '@kuralle-agents/core';
import { RedisExtractedValueStore, fromUpstash } from '@kuralle-agents/redis-store';

const redis = fromUpstash(Redis.fromEnv());

const agent = defineAgent({
  id: 'support',
  model,
  instructions: 'Help the customer.',
  memory: {
    preload: { enabled: true, tokenBudget: 500 },
    extract: [factsExtractor()],
  },
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'support',
  extractedValueStore: new RedisExtractedValueStore({ client: redis }),
});
```

Pass a `userId` on every run — `runtime.run({ input, sessionId, userId })`. Memory is
owner-scoped, and a session without a `userId` gets no user-scoped memory at all rather
than sharing a pooled one.

## Working memory blocks

```ts
import { createRuntime } from '@kuralle-agents/core';
import { RedisPersistentMemoryStore, fromUpstash } from '@kuralle-agents/redis-store';
import { Redis } from '@upstash/redis';

const client = Redis.fromEnv();
const workingMemoryStore = new RedisPersistentMemoryStore({ client, prefix: 'kuralle' });

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'support',
  defaultWorkingMemoryStore: workingMemoryStore,
});
```

On Cloudflare Workers, use `fromUpstash` with the REST client — no TCP socket required.

## Related

- [`@kuralle-agents/core`](https://www.npmjs.com/package/@kuralle-agents/core) — `SessionStore` interface and runtime.
- [`@kuralle-agents/rag`](https://www.npmjs.com/package/@kuralle-agents/rag) — `VectorStoreCore` interface.
- [`@kuralle-agents/postgres-store`](https://www.npmjs.com/package/@kuralle-agents/postgres-store) — Postgres alternative.
