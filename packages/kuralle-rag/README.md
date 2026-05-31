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
- **Search** — `BM25Index` (keyword search for hybrid retrieval)
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

`HybridRetriever` combines vector and BM25 keyword search with configurable weight:

```ts
import { HybridRetriever, BM25Index } from '@kuralle-agents/rag';

const bm25 = new BM25Index();
// index documents into bm25...

const retriever = new HybridRetriever({
  vectorRetriever,
  keywordRetriever: bm25,
  alpha: 0.7,   // 0 = keyword-only, 1 = vector-only
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
