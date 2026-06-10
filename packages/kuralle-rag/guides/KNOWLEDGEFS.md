# KnowledgeFs — read-only filesystem over RAG

`KnowledgeFs` implements the RFC-02 `FileSystem` interface over an existing `@kuralle-agents/rag` vector store. Customer-support agents explore a knowledge base with the same `workspace` tool verbs (`ls`, `cat`, `grep`, `find`) used for bundled docs.

## Quick start

```ts
import { defineAgent, createRuntime } from '@kuralle-agents/core';
import { KnowledgeFs } from '@kuralle-agents/rag/fs';
import { InMemoryVectorStore } from '@kuralle-agents/rag';

const store = new InMemoryVectorStore();
await store.createIndex({ indexName: 'kb', dimension: 4 });
await store.upsert('kb', [{
  id: 'faq#0',
  vector: [0, 0, 0, 0],
  metadata: { page: '/faq.md', chunk_index: 0 },
  document: 'Returns are accepted within 30 days.',
}]);

const workspace = await KnowledgeFs.open({ store, indexName: 'kb' });

const agent = defineAgent({
  id: 'support',
  instructions: 'Use workspace grep+cat to answer from the KB.',
  workspace,
});
```

Live smoke (requires `OPENAI_API_KEY`):

```bash
KURALLE_EXAMPLE_PROVIDER=openai bun packages/kuralle-rag/examples/support-kb-agent.ts
```

## Metadata contract

Each vector entry for a KB page chunk MUST include:

| Field | Type | Purpose |
|-------|------|---------|
| `page` | `string` | Absolute-style slug, e.g. `/policies/returns.md` |
| `chunk_index` | `number` | Zero-based order within the page |

`cat`/`readFile` fetches all chunks for a slug, sorts by `chunk_index`, joins `document` text, and caches the page for the session.

Optional manifest: store a document with id `__path_tree__` containing JSON `{ "/path/slug": { "isPublic": true } }` to bootstrap the directory tree without scanning all chunk metadata.

## RBAC

Pass `accessFilter` when constructing `KnowledgeFs`:

```ts
const workspace = await KnowledgeFs.open({
  store,
  indexName: 'kb',
  accessFilter: {
    vectorFilter: { tier: 'free' },
    allowSlug: (slug) => !slug.startsWith('/internal'),
  },
});
```

Paths pruned at tree-build time are invisible to `ls` and return `ENOENT` on `cat`. Derive filters from trusted session identity — never from model input.

## Grep (coarse → fine)

`KnowledgeFs.search()` implements the coarse pass. RFC-02 `createFsTool` detects the optional hook and greps only candidate slugs before running line-level regex — same model API, faster on large KBs.

Pass a `keywordIndex` to make the coarse pass BM25-ranked (hits return in
relevance order, not corpus order):

```ts
import { BM25Index, Fts5KeywordIndex } from '@kuralle-agents/rag';

// In-memory: seeded from the store on every open()
const workspace = await KnowledgeFs.open({ store, indexName: 'kb', keywordIndex: new BM25Index() });

// Persistent (Durable Object SQLite / bun:sqlite): a pre-populated index is
// detected (size > 0) and open() skips seeding — a hibernated DO wakes with
// zero rebuild. The ingest path keeps it in sync (RagPipeline keywordIndex
// option); call clear() on it to force a reseed on the next open().
const workspace = await KnowledgeFs.open({
  store,
  indexName: 'kb',
  keywordIndex: new Fts5KeywordIndex({ sql: createSqlExecutor(ctx.storage.sql) }),
});
```

Without a `keywordIndex`, `search()` falls back to a linear regex scan.

## Workers

`KnowledgeFs` adds no `node:*` imports. It runs anywhere the underlying `VectorStoreCore` runs (including Cloudflare Vectorize via `@kuralle-agents/vectorize-store`).

## Read-only

All write/mutate `FileSystem` ops throw `EROFS`. Use `InMemoryFs` or a writable backend when the agent must edit files.
