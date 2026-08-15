# Session Stores (80/20)

## Options

- Memory store (default) — dev only
- Redis store — production
- Postgres store — production

## Redis store

Package: `@kuralle-agents/redis-store`

Use when you need fast shared sessions.

## Postgres store

Package: `@kuralle-agents/postgres-store`

Use when you already operate Postgres.

## Run stores (durable run journal)

`createRuntime({ runStore })` sets the durable run journal. Omitted, each session journals through `SessionRunStore` over the session store — fine for one process, invisible to cross-replica sweeps.

- `PostgresRunStore` — `@kuralle-agents/postgres-store`
- `SqlRunStore` — `@kuralle-agents/cf-agent` (Durable Object SQLite)

A shared run store is what makes `recoverOrphanedRuns` / `sweepDeadlines` see runs from crashed replicas. See `references/runtime.md`.

## Flow definition stores (versioned dynamic flows)

`createRuntime({ flowDefinitionsStore })` sets the default store for `addDynamicFlows` / `loadDynamicFlows`.

- `MemoryFlowDefinitionsStore` — core, dev only
- `PostgresFlowDefinitionsStore` — `@kuralle-agents/postgres-store`
- `RedisFlowDefinitionsStore` — `@kuralle-agents/redis-store`
- `SqlFlowDefinitionsStore` — `@kuralle-agents/cf-agent` (Durable Object SQLite)

See `references/flow-definitions.md`.

## Where to read more

- `node_modules/@kuralle-agents/redis-store/README.md`
- `node_modules/@kuralle-agents/postgres-store/README.md`
