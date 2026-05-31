# @kuralle-agents/vectorize-store

Cloudflare Vectorize adapter for Kuralle RAG pipelines.

## Install

```bash
npm install @kuralle-agents/vectorize-store
```

Peer: `@kuralle-agents/rag`.

## What it does

`CloudflareVectorizeStore` implements `VectorStoreCore` from `@kuralle-agents/rag`, backed by Cloudflare Vectorize — designed for use inside Cloudflare Workers.

**Key exports:**

- **`CloudflareVectorizeStore`** — `VectorStoreCore` implementation for Cloudflare Vectorize.

## Usage

```ts
import { CloudflareVectorizeStore } from '@kuralle-agents/vectorize-store';
import { AiSdkEmbedder, VectorRetriever } from '@kuralle-agents/rag';
import { createOpenAI } from '@ai-sdk/openai';

interface Env {
  VECTORIZE: VectorizeIndex;
  OPENAI_API_KEY: string;
}

export default {
  async fetch(request: Request, env: Env) {
    const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
    const vectorStore = new CloudflareVectorizeStore({ index: env.VECTORIZE });
    const embedder = new AiSdkEmbedder({ model: openai.embedding('text-embedding-3-small') });
    const retriever = new VectorRetriever({ store: vectorStore, embedder, indexName: 'docs', topK: 5 });
    // ...
  },
};
```

Use `createVectorRetrievalTool` from `@kuralle-agents/tools` to attach this retriever as an agent tool.

## Related

- [`@kuralle-agents/rag`](https://www.npmjs.com/package/@kuralle-agents/rag) — `VectorStoreCore` interface, retrievers, embedders.
- [`@kuralle-agents/tools`](https://www.npmjs.com/package/@kuralle-agents/tools) — `createVectorRetrievalTool`.
- [`@kuralle-agents/cf-agent`](https://www.npmjs.com/package/@kuralle-agents/cf-agent) — Cloudflare Durable Objects agent integration.
