# @kuralle-agents/lancedb-store

LanceDB vector store adapter for Kuralle RAG pipelines.

## Install

```bash
npm install @kuralle-agents/lancedb-store @lancedb/lancedb
```

Peers: `@kuralle-agents/rag @lancedb/lancedb@>=0.13.0`.

## What it does

`LanceDBVectorStore` implements `VectorStoreCore` from `@kuralle-agents/rag`, backed by LanceDB — an embedded, file-based vector database that runs in-process without an external server.

**Key exports:**

- **`LanceDBVectorStore`** — `VectorStoreCore` implementation for LanceDB.

## Usage

```ts
import { LanceDBVectorStore } from '@kuralle-agents/lancedb-store';
import { AiSdkEmbedder, VectorRetriever } from '@kuralle-agents/rag';
import { openai } from '@ai-sdk/openai';

const vectorStore = new LanceDBVectorStore({ uri: './lancedb-data' });
const embedder = new AiSdkEmbedder({ model: openai.embedding('text-embedding-3-small') });
const retriever = new VectorRetriever({ store: vectorStore, embedder, indexName: 'docs', topK: 5 });
```

Use `createVectorRetrievalTool` from `@kuralle-agents/tools` to attach this retriever as an agent tool.

## Related

- [`@kuralle-agents/rag`](https://www.npmjs.com/package/@kuralle-agents/rag) — `VectorStoreCore` interface, retrievers, embedders.
- [`@kuralle-agents/tools`](https://www.npmjs.com/package/@kuralle-agents/tools) — `createVectorRetrievalTool`.
- [`@kuralle-agents/vectorize-store`](https://www.npmjs.com/package/@kuralle-agents/vectorize-store) — Cloudflare Vectorize alternative.
