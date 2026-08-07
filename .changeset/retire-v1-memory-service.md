---
'@kuralle-agents/core': major
'@kuralle-agents/postgres-store': major
'@kuralle-agents/redis-store': major
---

**BREAKING — the V1 `MemoryService` interface and its four implementations are removed.**

`MemoryService` (the `addSessionToMemory` / `searchMemory` / `deleteMemories`
interface in `packages/core/src/memory/MemoryService.ts`), `InMemoryMemoryService`,
`PostgresMemoryService`, `PostgresMemoryStoreOptions`, `RedisMemoryService` and
`RedisMemoryStoreOptions` are deleted with no shim. `RefineInput.memoryService`
is dropped from `RefinementCapability`.

This interface had zero production consumers: `addSessionToMemory` and
`deleteMemories` were dead since the ingest path was retired, and
`runRefinementPolicies` passed `memoryService: undefined` unconditionally —
nothing ever supplied a `searchMemory` implementation at runtime.

```ts
// before
class MyMemory implements MemoryService {
  async searchMemory(request) { /* ... */ }
}
createRuntime({ /* no supported way to wire memoryService in */ })

// after — automatic recall (unchanged, already live)
defineAgent({ memory: { preload: { enabled: true }, extract: [factsExtractor()] } })
// after — explicit search (arriving in a follow-up change)
// a `search_memory` tool over `ExtractedValueStore`, beside `memory_block`
```

**No type named `MemoryService` is exported from `@kuralle-agents/core` after this
change.** A *different*, unrelated interface of the same name lives in
`packages/core/src/types/run-context.ts` (`{ preload?(ctx, scope) }`) and backs the
automatic recall path — but it has never been a named export, and is only reachable
as the type of `RunContext['memoryService']`. It is untouched. If you were importing
`MemoryService` by name, you were importing the V1 one, and there is no replacement
for it: configure `memory.preload` on the agent instead.

`HackerMemoryService` in the `postgres-hacker-starter` example, and the
`InMemoryMemoryService` usage in the `memory-demo` examples, are migrated onto
`memory.preload` + `extract: [factsExtractor()]` with an `ExtractedValueStore`.

**Also removed, because they existed only to serve the deleted interface:**
`MemoryEntry`, `MemoryIngestionOptions` and `extractMemories`. `MemoryEntry` was
the shape `searchMemory` returned, `MemoryIngestionOptions` the options
`addSessionToMemory` took, and `extractMemories` the helper that turned a closed
session into rows for the two adapter-backed implementations. With those gone,
each had zero callers and could only be used in combination with something that
no longer exists — so they are removed rather than left as exports that lead
nowhere.
