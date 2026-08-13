# @kuralle-agents/postgres-store

Postgres-backed deployment, session, run, flow-definition, memory, trace, and vector stores for Kuralle.

## Install

```bash
npm install @kuralle-agents/postgres-store pg
```

Peers: `@kuralle-agents/core @kuralle-agents/rag pg@^8`.

## What it does

Postgres-backed session, run, flow-definition, memory, trace, deployment, and pgvector stores, sharing one connection pool.

**Key exports:**

- **`PostgresSessionStore`** — `SessionStore` implementation for durable session persistence.
- **`PostgresRunStore`** — row-per-step `RunStore` (run state + journal), selected via `HarnessConfig.runStore`.
- **`PostgresFlowDefinitionsStore`** — versioned `FlowDefinitionsStore` for dynamic `FlowDefinition`s.
- **`PostgresTraceStore`** — independent native trace persistence and read API.
- **`PostgresExtractedValueStore`** — durable store for extractor output (cross-session memory).
- **`PostgresPersistentMemoryStore`** — `PersistentMemoryStore` for durable USER/MEMORY markdown blocks.
- **`PgVectorStore`** — `VectorStoreCore` implementation using pgvector for similarity search.
- **`PostgresDeploymentStore`** — immutable agent versions, releases, and sticky thread pins.

## Deployment store

The deployment store never changes an application database merely because it was constructed.
Apply its schema explicitly through your migration workflow:

```ts
import { Pool } from 'pg';
import {
  PostgresDeploymentStore,
  postgresDeploymentMigrationSql,
} from '@kuralle-agents/postgres-store';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PostgresDeploymentStore({ client: pool });

// Migration-generation script: write this result into a reviewed migration.
console.log(postgresDeploymentMigrationSql({ tablePrefix: 'kuralle_deploy' }));

// Explicit alternative for a dedicated database or controlled bootstrap job.
await store.migrate();
```

`autoMigrate: true` remains an opt-in convenience for ephemeral tests and dedicated databases. A
Prisma or Drizzle application should keep schema application in Prisma Migrate or Drizzle Kit. The
first-party store uses a `pg`-compatible connection; a project that wants all queries to go through
its ORM can implement the workerd-safe `DeploymentStore` port over its existing models.

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

## Run store

```ts
import { Pool } from 'pg';
import { createRuntime } from '@kuralle-agents/core';
import { PostgresRunStore, PostgresSessionStore } from '@kuralle-agents/postgres-store';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sessionStore = new PostgresSessionStore({ client: pool });
const runStore = new PostgresRunStore({ client: pool });

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'support',
  sessionStore,
  runStore,
});
```

Tables: `kuralle_run_state` (PK `run_id`, index on `(status, kind)`) and `kuralle_run_steps` (PK `(run_id, index)`). `autoMigrate` defaults to `true`. Override `stateTableName` / `stepsTableName` for tests.

Durable flow runs (`runtime.run({ kind: 'flow', flowName })`) journal here, and the core sweepers (`recoverOrphanedRuns` / `sweepDeadlines`) read the same store via `listRuns`.

## Flow definitions store

Versioned storage for dynamic `FlowDefinition`s — the backend for `runtime.addDynamicFlows` / `loadDynamicFlows` and the hono-server `createStoredFlowsRouter`:

```ts
import { createRuntime } from '@kuralle-agents/core';
import { PostgresFlowDefinitionsStore } from '@kuralle-agents/postgres-store';

const flowDefinitionsStore = new PostgresFlowDefinitionsStore({ client: pool });

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'support',
  flowDefinitionsStore,
});

await runtime.loadDynamicFlows({ agentId: 'support' });   // boot: reload active versions
```

Table: `kuralle_flow_definition_versions`. Options: `tableName`, `autoMigrate` (default `true`). See the [dynamic flows guide](https://agents.kuralle.com/guides/dynamic-flows).

## Trace store

```ts
import { PostgresTraceStore } from '@kuralle-agents/postgres-store';

const traceStore = new PostgresTraceStore({ client: pool, retentionMs: 604_800_000 });
const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'support',
  tracing: { store: traceStore },
});
```

Spans live in the separate `kuralle_trace_spans` table. Set `tableName` to override it.

## Session store options

- `tableName` (default: `'kuralle_sessions'`) — table to store sessions.
- `autoMigrate` (default: `true`) — create the table on first use.

## Long-term memory

Cross-session memory is configured on the **agent**, not the runtime. Extractors
decide what is worth keeping; `preload` puts the relevant parts back into the next
session's prompt.

```ts
import { defineAgent, createRuntime, factsExtractor } from '@kuralle-agents/core';
import { PostgresExtractedValueStore } from '@kuralle-agents/postgres-store';

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
  extractedValueStore: new PostgresExtractedValueStore({ client: pool }),
});
```

Pass a `userId` on every run — `runtime.run({ input, sessionId, userId })`. Memory is
owner-scoped, and a session without a `userId` gets no user-scoped memory at all rather
than sharing a pooled one.

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
