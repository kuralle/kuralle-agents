---
'@kuralle-agents/core': major
---

**BREAKING — fact memory is now an extractor, and `memory.ingest` is gone.**

`createFactMemoryService`, `AgentMemory.ingest`, `runMemoryIngest`,
`HarnessConfig.memoryService` and `createLoadMemoryTool` are removed with no
shim. Facts are now produced by `factsExtractor()` on the general extraction
pipeline and stored in an `ExtractedValueStore`.

```ts
// before
createRuntime({ memoryService: createFactMemoryService({ store, model }) })
defineAgent({ memory: { ingest: { enabled: true } } })

// after
createRuntime({ extractedValueStore: new PostgresExtractedValueStore({ client }) })
defineAgent({ memory: { preload: { enabled: true }, extract: [factsExtractor()] } })
```

**Two things to check when you upgrade.**

*Existing facts are not migrated.* They live in the `FACTS` block of your
`PersistentMemoryStore`; the new read path looks up slug `facts` in an
`ExtractedValueStore` — a different interface, a different key, usually a
different backend. Nothing reads the old block. Agents will rebuild their fact
list from new conversations rather than inheriting it. If you need the old
facts, copy them across before upgrading; there is no automatic path.

*Set `extractedValueStore` explicitly in production.* On Node it defaults to the
file store (`KURALLE_MEMORY_DIR` or `~/.kuralle/extracted`), which is durable but
local to one machine. On workerd, and anywhere multi-instance, pass a real
backend — `PostgresExtractedValueStore`, `RedisExtractedValueStore` or
`SqlExtractedValueStore` — or facts will not be shared across instances.

`HarnessConfig.memoryService` was deleted rather than deprecated so that leaving
it wired is a compile error instead of silently dropped configuration.

`memory.preload` and `memory.workingMemory` are unchanged.
