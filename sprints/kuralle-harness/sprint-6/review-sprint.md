# Sprint 6 review — DB-backed + CF-native working memory + composite stores

**IC:** cursor · **Commit:** `3bbb54d` `[kh-dbm-1]` · **Decision: PROCEED → done.**

## Gate 6 (manager-run, observed)
- `bun run build && typecheck:all && test` green (GATEDBM_EXIT=0); playground green.
- proof gate `PROOF_OK` (4 claims / 8 assertions).
- core routed/tiered/durability 24/0; cf-agent SqlPersistentMemoryStore unit 2/0; **CF workerd `sql-memory-workers.test.ts` 1/0** (day-1 CF gate); redis-store 26/0; postgres-store 27/0.
- **CF-FIRST held:** zero `node:` in `RoutedPersistentMemoryStore`, `TieredPersistentMemoryStore`, and `SqlPersistentMemoryStore`.

## Delivered (5 stores + 2 composites)
- **CF-native `SqlPersistentMemoryStore`** (`@kuralle-agents/cf-agent`) — `working_memory_blocks` table on DO-embedded SQLite via `SqlExecutor` (OrchestrationStore pattern). Durable working memory on Workers, no external DB.
- `RedisPersistentMemoryStore` (`@kuralle-agents/redis-store`) — `wm:<scope>:<owner>:<key>`; Workers path = Upstash REST (`fromUpstash`).
- `PostgresPersistentMemoryStore` (`@kuralle-agents/postgres-store`) — `working_memory_blocks` table + upsert (CF via Hyperdrive).
- `RoutedPersistentMemoryStore` (core) — the "CompositeMemoryStore": route blocks by scope to different backends.
- `TieredPersistentMemoryStore` (core) — read-through cache over a durable store.

## Notes
Durability proven via FilePersistentMemoryStore real-disk IO tests + CF workerd DO-SQLite test. No cycle/dynamic-import. Live DB round-trips run only if DATABASE_URL/REDIS_URL/UPSTASH_* present; otherwise fake-client/disk tests stand in.
