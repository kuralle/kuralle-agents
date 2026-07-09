# @kuralle-agents/upstash-store

Upstash Vector store adapter for Kuralle RAG pipelines.

## Install

```bash
npm install @kuralle-agents/upstash-store @upstash/vector
```

Peer: `@kuralle-agents/rag`.

## What it does

`UpstashVectorStore` implements `VectorStoreCore` from `@kuralle-agents/rag`, backed by Upstash Vector's serverless vector database.

**Key exports:**

- **`UpstashVectorStore`** — `VectorStoreCore` implementation for Upstash Vector.

## Usage

```ts
import { Index } from '@upstash/vector';
import { UpstashVectorStore } from '@kuralle-agents/upstash-store';
import { AiSdkEmbedder, VectorRetriever } from '@kuralle-agents/rag';
import { openai } from '@ai-sdk/openai';

const index = new Index({
  url: process.env.UPSTASH_VECTOR_REST_URL,
  token: process.env.UPSTASH_VECTOR_REST_TOKEN,
});

const vectorStore = new UpstashVectorStore({ index });
const embedder = new AiSdkEmbedder({ model: openai.embedding('text-embedding-3-small') });
const retriever = new VectorRetriever({ store: vectorStore, embedder, indexName: 'docs', topK: 5 });
```

Use `createVectorRetrievalTool` from `@kuralle-agents/tools` to attach this retriever as an agent tool.

## Related

- [`@kuralle-agents/rag`](https://www.npmjs.com/package/@kuralle-agents/rag) — `VectorStoreCore` interface, retrievers, embedders.
- [`@kuralle-agents/tools`](https://www.npmjs.com/package/@kuralle-agents/tools) — `createVectorRetrievalTool`.
- [`@kuralle-agents/redis-store`](https://www.npmjs.com/package/@kuralle-agents/redis-store) — Redis-backed session + vector store.
