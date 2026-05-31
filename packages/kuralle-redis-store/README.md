# @kuralle-agents/redis-store

Redis-backed session store, memory service, and vector store for Kuralle.

## Install

```bash
npm install @kuralle-agents/redis-store
```

Peers: `@kuralle-agents/core @kuralle-agents/rag`.

## What it does

Three backend implementations — sessions, long-term memory, and vector search — all backed by Redis. Works with Upstash, node-redis, ioredis, or any client that exposes compatible `get` / `set` / `del` commands.

**Key exports:**

- **`RedisSessionStore`** — `SessionStore` implementation for durable session persistence.
- **`RedisMemoryService`** — `MemoryService` implementation for cross-session long-term memory.
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

```ts
import { createRuntime, InMemoryMemoryService } from '@kuralle-agents/core';
import { RedisMemoryService, fromUpstash } from '@kuralle-agents/redis-store';

const redis = fromUpstash(Redis.fromEnv());
const memoryService = new RedisMemoryService({ client: redis });

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'support',
  memoryService,
  preloadMemory: true,
  memoryIngestion: 'onEnd',
});
```

## Related

- [`@kuralle-agents/core`](https://www.npmjs.com/package/@kuralle-agents/core) — `SessionStore` interface and runtime.
- [`@kuralle-agents/rag`](https://www.npmjs.com/package/@kuralle-agents/rag) — `VectorStoreCore` interface.
- [`@kuralle-agents/postgres-store`](https://www.npmjs.com/package/@kuralle-agents/postgres-store) — Postgres alternative.
