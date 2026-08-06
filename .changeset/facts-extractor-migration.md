---
"@kuralle-agents/core": minor
---

Replace `memory.ingest` / `createFactMemoryService` with the built-in `factsExtractor()` on `memory.extract`. Cross-session fact memory now persists to `ExtractedValueStore` (slug `facts`); `memory.preload` reads from there.

**Migration:** remove `memory.ingest` and `HarnessConfig.memoryService` wiring for fact memory. Add `memory.extract: [factsExtractor()]` and optionally `memory.extraction` cadence. `createFactMemoryService`, `runMemoryIngest`, and `AgentMemory.ingest` are removed — no deprecation shim.
