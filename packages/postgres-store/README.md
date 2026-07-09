# @kuralle-agents/postgres-store

Postgres-backed session store, memory service, and vector store for Kuralle.

## Install

```bash
npm install @kuralle-agents/postgres-store pg
```

Peers: `@kuralle-agents/core @kuralle-agents/rag pg@^8`.

## What it does

Three backend implementations — sessions, long-term memory, and pgvector similarity search — backed by a single Postgres connection pool.

**Key exports:**

- **`PostgresSessionStore`** — `SessionStore` implementation for durable session persistence.
- **`PostgresMemoryService`** — `MemoryService` implementation for cross-session long-term memory.
- **`PostgresPersistentMemoryStore`** — `PersistentMemoryStore` for durable USER/MEMORY markdown blocks.
- **`PgVectorStore`** — `VectorStoreCore` implementation using pgvector for similarity search.

## Session store

```ts
import { Pool } from 'pg';
import { createRuntime } from '@kuralle-agents/core';
import { PostgresSessionStore } from '@kuralle-agents/postgres-store';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sessionStore = new PostgresSessionStore({ client: pool });

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'support',
  sessionStore,
});
```

## Store options

- `tableName` (default: `'kuralle_sessions'`) — table to store sessions.
- `autoMigrate` (default: `true`) — create the table on first use.

## Long-term memory

```ts
import { PostgresMemoryService } from '@kuralle-agents/postgres-store';

const memoryService = new PostgresMemoryService({ client: pool });

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'support',
  memoryService,
  preloadMemory: true,
  memoryIngestion: 'onEnd',
});
```

## Working memory blocks

```ts
import { PostgresPersistentMemoryStore } from '@kuralle-agents/postgres-store';

const workingMemoryStore = new PostgresPersistentMemoryStore({ client: pool });

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'support',
  defaultWorkingMemoryStore: workingMemoryStore,
});
```

On Cloudflare Workers, connect the pool through [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) rather than a direct TCP connection.

## Vector store (pgvector)

Requires the `pgvector` extension in your Postgres instance.

```ts
import { PgVectorStore } from '@kuralle-agents/postgres-store';
import { AiSdkEmbedder, VectorRetriever } from '@kuralle-agents/rag';
import { openai } from '@ai-sdk/openai';

const vectorStore = new PgVectorStore({ client: pool, tableName: 'kuralle_vectors' });
const embedder = new AiSdkEmbedder({ model: openai.embedding('text-embedding-3-small') });
const retriever = new VectorRetriever({ store: vectorStore, embedder, indexName: 'docs', topK: 5 });
```

## Related

- [`@kuralle-agents/core`](https://www.npmjs.com/package/@kuralle-agents/core) — `SessionStore` interface and runtime.
- [`@kuralle-agents/rag`](https://www.npmjs.com/package/@kuralle-agents/rag) — `VectorStoreCore` interface.
- [`@kuralle-agents/redis-store`](https://www.npmjs.com/package/@kuralle-agents/redis-store) — Redis alternative.
