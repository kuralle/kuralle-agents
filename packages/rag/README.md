# @kuralle-agents/rag

RAG primitives for Kuralle: chunkers, embedders, vector stores, retrievers, rerankers, and pipelines.

## Install

```bash
npm install @kuralle-agents/rag
```

Peers: `ai@^6 zod`.

## What it does

Everything between a raw document and a grounded agent response: chunk documents, embed them, store vectors, retrieve by similarity, rerank results, and run a full pipeline. Plug any backend via the `VectorStoreCore` interface.

**Key exports:**

- **Chunkers** — `createMarkdownChunker`, `createRecursiveChunker`, `createTokenChunker`
- **Sources** — `createStaticKnowledgeSource` (CAG knowledge source)
- **Embedders** — `AiSdkEmbedder` (any AI SDK embedding model)
- **Vector stores** — `InMemoryVectorStore`; adapters in sibling packages
- **Retrievers** — `VectorRetriever`, `HybridRetriever`, `FusionRetriever`, `MultiHopRetriever`, `createLLMRetriever`
- **Rerankers** — `LLMReranker`, `CohereReranker`
- **Search** — `KeywordIndex` contract: `BM25Index` (in-memory) and `Fts5KeywordIndex` (persistent SQLite FTS5; survives DO hibernation)
- **KnowledgeFs** — read-only `FileSystem` over a vector store (`@kuralle-agents/rag/fs`); see [guides/KNOWLEDGEFS.md](./guides/KNOWLEDGEFS.md)
- **Pipeline** — `RagPipeline`, `RetrievalQualityChecker`
- **Cache** — `RetrievalCache`, `TurnCache`, `PredictivePreFetcher`

## Usage

```ts
import {
  createMarkdownChunker,
  AiSdkEmbedder,
  InMemoryVectorStore,
  VectorRetriever,
} from '@kuralle-agents/rag';
import { openai } from '@ai-sdk/openai';

const embedder = new AiSdkEmbedder({ model: openai.embedding('text-embedding-3-small') });
const store = new InMemoryVectorStore();
const chunker = createMarkdownChunker();

// Index documents
const chunks = await chunker.chunk({ content: '# Docs\nKuralle is a TypeScript agent framework.' });
await store.upsert('docs', chunks.map((c, i) => ({
  id: `chunk-${i}`,
  vector: await embedder.embed(c.text),
  content: c.text,
  metadata: {},
})));

// Retrieve
const retriever = new VectorRetriever({ store, embedder, indexName: 'docs', topK: 5 });
const results = await retriever.retrieve('What is Kuralle?');
```

## Hybrid retrieval

`FusionRetriever` fuses a BM25 keyword tier with vector similarity (weighted,
min-max normalized). The keyword tier is any `KeywordIndex`: the in-memory
`BM25Index`, or the persistent `Fts5KeywordIndex` (SQLite FTS5 — on Cloudflare,
Durable Object SQLite supports FTS5, so the keyword tier survives hibernation
with zero rebuild):

```ts
import { FusionRetriever, BM25Index, Fts5KeywordIndex } from '@kuralle-agents/rag';

const keywordIndex = new BM25Index();           // in-memory
// const keywordIndex = new Fts5KeywordIndex({  // persistent (DO SQLite / bun:sqlite)
//   sql: createSqlExecutor(ctx.storage.sql),   // from @kuralle-agents/cf-agent
// });

const retriever = new FusionRetriever({
  keywordIndex,
  vectorStore,
  embedder,
  indexName: 'docs',
  bm25Weight: 0.3, // 70% vector, 30% keyword
});
```

`HybridRetriever` is the generic alternative: it fuses any set of `Retriever`s
with reciprocal rank fusion (`sources: [{ retriever, weight }]`).

## Incremental ingest + embedder lock

Give `RagPipeline` a persistent `IngestManifest` and it (a) skips unchanged
documents on re-ingest (SHA-256 content hash — zero embed calls for a stable
corpus), (b) cleans up stale chunks of changed documents, and (c) **locks the
index to the embedding model that built it**: ingesting or querying with a
different model — even one with the same dimension — throws instead of
silently corrupting relevance.

```ts
import { RagPipeline, SqlIngestManifest, InMemoryIngestManifest } from '@kuralle-agents/rag';

const pipeline = new RagPipeline({
  embedder,
  vectorStore,
  chunker,
  indexName: 'docs',
  manifest: new SqlIngestManifest({ sql }), // DO SQLite / bun:sqlite; InMemoryIngestManifest for dev
  keywordIndex,                             // optional: kept in sync at ingest
});
```

## Vector store backends

| Package | Backend |
|---------|---------|
| `@kuralle-agents/rag` | `InMemoryVectorStore` (dev/test) |
| `@kuralle-agents/redis-store` | `RedisVectorStore` |
| `@kuralle-agents/postgres-store` | `PgVectorStore` (pgvector) |
| `@kuralle-agents/upstash-store` | `UpstashVectorStore` |
| `@kuralle-agents/lancedb-store` | `LanceDBVectorStore` |
| `@kuralle-agents/vectorize-store` | `CloudflareVectorizeStore` |

Use `createVectorRetrievalTool` from `@kuralle-agents/tools` to attach any of these as an agent tool.

## Related

- [`@kuralle-agents/core`](https://www.npmjs.com/package/@kuralle-agents/core) — runtime and agent primitives.
- [`@kuralle-agents/tools`](https://www.npmjs.com/package/@kuralle-agents/tools) — `createVectorRetrievalTool` and CAG tools.
- [`@kuralle-agents/rag-loaders`](https://www.npmjs.com/package/@kuralle-agents/rag-loaders) — PDF, URL, CSV, Markdown document loaders.
