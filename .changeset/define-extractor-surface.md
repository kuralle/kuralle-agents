---
"@kuralle-agents/core": minor
---

Add `defineExtractor` and the `AgentMemory.extract` configuration surface.

Cross-session memory was one hard-coded extractor: `createFactMemoryService` ran a `generateObject`
over `{ facts: string[] }` into a single FACTS block. There was no way to declare a second thing
worth remembering, no typed output any downstream code could consume, and no hook to forward a
learned value anywhere.

This lands the declaration surface only — the type, slug derivation, validation, and
`AgentMemory.extract`. No runner, no persistence, no model calls yet, which keeps it verifiable on
its own.

Two deliberate design choices. A Zod schema is **required**: schema-less tag-scraping is cheap only
if you already run an observer agent, which Kuralle does not, and it is fragile besides — every
extractor here is structured. And the slug is **derived** from the name rather than declared, so a
rename cannot silently orphan previously persisted values under a stale key.

`AgentConfig.extract` is typed `Extractor<never>[]`. The array holds extractors with different `T`s
and `T` appears contravariantly, so the correct common supertype is the one whose parameter accepts
least.
