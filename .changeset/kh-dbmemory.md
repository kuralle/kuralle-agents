---
"@kuralle-agents/core": minor
"@kuralle-agents/cf-agent": minor
"@kuralle-agents/postgres-store": minor
"@kuralle-agents/redis-store": minor
---

Add DB-backed working-memory block stores: `RoutedPersistentMemoryStore` and `TieredPersistentMemoryStore` in core; `SqlPersistentMemoryStore` (DO SQLite) in cf-agent; `PostgresPersistentMemoryStore` and `RedisPersistentMemoryStore` in their respective store packages. Includes durability tests and a vitest-pool-workers gate for CF-native storage.
