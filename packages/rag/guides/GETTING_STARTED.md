# Getting Started with Kuralle RAG

## Install

```bash
bun add @kuralle-agents/rag ai @ai-sdk/openai zod
```

## 1. Minimal: In-Memory Vector RAG

The fastest way to get RAG working. Uses `InMemoryVectorStore` (no external database), `AiSdkEmbedder` (Vercel AI SDK), and `RagPipeline` to wire everything together.

```ts
import { openai } from '@ai-sdk/openai';
import {
  AiSdkEmbedder,
  InMemoryVectorStore,
  RagPipeline,
  createRecursiveChunker,
} from '@kuralle-agents/rag';

// 1. Create primitives
const embedder = new AiSdkEmbedder({
  model: openai.embedding('text-embedding-3-small'),
});
const vectorStore = new InMemoryVectorStore();
const chunker = createRecursiveChunker({ maxChars: 1200, overlapChars: 120 });

// 2. Create pipeline (wires embedder + store + chunker)
const pipeline = new RagPipeline({
  embedder,
  vectorStore,
  chunker,
  indexName: 'docs',
});

// 3. Ingest documents
await pipeline.ingest([
  {
    id: 'refund-policy',
    text: 'Customers may request a full refund within 30 days of purchase...',
    metadata: { category: 'policy' },
  },
  {
    id: 'shipping-faq',
    text: 'Standard shipping takes 5-7 business days. Express is 1-2 days...',
    metadata: { category: 'faq' },
  },
]);

// 4. Retrieve
const results = await pipeline.retrieve('How long does shipping take?');
console.log(results);
// [{ id: 'shipping-faq:chunk-1', text: 'Standard shipping...', score: 0.87, ... }]
```

`RagPipeline.ingest()` handles the full flow: chunk the text, embed each chunk, create the vector index (if needed), and upsert the vectors. `retrieve()` embeds the query and searches by cosine similarity.

## 2. Add a Reranker

For higher retrieval quality, add an `LLMReranker`. The pipeline fetches 3x the requested topK from the vector store, then the reranker scores each candidate with an LLM and returns the top results.

```ts
import { LLMReranker } from '@kuralle-agents/rag';

const reranker = new LLMReranker({
  model: openai('gpt-4o-mini'),
  topK: 5,
  includeReasons: true,
});

const pipeline = new RagPipeline({
  embedder,
  vectorStore,
  chunker,
  indexName: 'docs',
  reranker, // added
});

const results = await pipeline.retrieve('What is the refund window?');
// results are now reranked by LLM relevance judgment
// each result has a .reason field explaining why it was selected
```

## 3. Wire to an Agent

`RagPipeline` implements the `Retriever` interface, so it can be passed directly to `createVectorRetrievalTool()`. The tool lets the LLM decide when to search.

```ts
import { createVectorRetrievalTool } from '@kuralle-agents/rag';
import { defineAgent } from '@kuralle-agents/core';

const searchTool = createVectorRetrievalTool({
  retriever: pipeline,
  topK: 10,
});

const agent = defineAgent({
  id: 'support',
  name: 'Support Agent',
  model: openai('gpt-4o'),
  instructions: 'You are a support agent. Use search_knowledge to look up answers.',
  tools: { search_knowledge: searchTool },
});
```

When the user asks a question, the LLM calls the `search_knowledge` tool, which embeds the query, searches the vector store, and returns matching chunks. The LLM then generates a grounded answer from the results.

## 4. Enable Agentic Filters

If your documents have structured metadata (category, region, date), enable agentic filters so the LLM can construct metadata filters at query time.

```ts
const searchTool = createVectorRetrievalTool({
  retriever: pipeline,
  topK: 10,
  enableAgenticFilters: true,
  filterableFields: [
    {
      field: 'category',
      description: 'Document category',
      type: 'string',
      examples: ['policy', 'faq', 'guide'],
    },
    {
      field: 'region',
      description: 'Geographic region',
      type: 'string',
      examples: ['EU', 'US', 'APAC'],
    },
  ],
});
```

The LLM now sees the available filter fields in the tool description and can call:
```json
{ "query": "refund policy", "filter": { "region": "EU" } }
```

This narrows retrieval to EU-specific documents before vector similarity is applied.

## 5. Swap to Postgres for Production

Replace `InMemoryVectorStore` with `PgVectorStore`. Everything else stays the same.

```ts
import { PgVectorStore } from '@kuralle-agents/vector-pg';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const vectorStore = new PgVectorStore({ client: pool });

const pipeline = new RagPipeline({
  embedder,
  vectorStore, // swapped
  chunker,
  indexName: 'docs',
  reranker,
});
```

Agent and tool code require zero changes. The `VectorStore` interface is the boundary.

## 6. Static Knowledge Sources (CAG Pattern)

The CAG (Chunk and Generate) API works best for small, curated content that doesn't need vector search. The LLM ranks all candidate chunks directly -- precise for small knowledge bases, but does not scale to thousands of documents.

```ts
import { createStaticKnowledgeSource, createLLMRetriever } from '@kuralle-agents/rag';

const source = createStaticKnowledgeSource({
  id: 'support-pack',
  name: 'Support Pack',
  content: 'Refunds: 30 days. Cancellations: anytime.',
});

const retriever = createLLMRetriever({
  model: openai('gpt-4o-mini') as any,
  topK: 4,
});

const hits = await retriever.retrieve('What is the refund policy?', [source]);
```

CAG and vector RAG are parallel paths -- use whichever fits your use case. CAG for small curated content where the LLM reads everything. Vector RAG for large knowledge bases where embedding similarity narrows the search space first.
