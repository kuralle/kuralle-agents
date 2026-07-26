---
'@kuralle-agents/redis-store': minor
'@kuralle-agents/cli': patch
---

`RedisSessionStore` now does a genuinely atomic compare-and-swap.

`save()` did `GET` → compare in JS → `SET`: three round-trips, so two clients could both read version 5, both pass the check, and both write. The check read as protection and provided none. It now runs a Lua script server-side, where read-compare-write is atomic.

Because client `eval` signatures differ (ioredis takes positional `numKeys`, node-redis an options object, Upstash two arrays), `RedisClientLike` gains a normalised `evalScript` hook and the `fromIORedis` / `fromNodeRedis` / `fromUpstash` adapters supply the mapping — previously they were pass-throughs that added nothing. A client without it now fails loudly at `save()` rather than silently losing writes.

The test double was also corrected: its `set` performed the version check itself, which a real Redis does not do, so the store's missing CAS was invisible to its own suite.

`fileSessionStore` (CLI) now runs `runSessionStoreContract` and `runSessionStoreCasContract` — the shared batteries that `MemoryStore`, Postgres and Redis already ran, and that this store never adopted.
