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

Pair Vectorize with **Workers AI embeddings** — the embedding model runs inside
Cloudflare's network (`env.AI` binding), so every query embedding skips the
public-internet round trip a cloud embedding API costs, and no provider API key
is needed. `AiSdkEmbedder` accepts the model from
[`workers-ai-provider`](https://www.npmjs.com/package/workers-ai-provider)
directly:

```ts
import { CloudflareVectorizeStore } from '@kuralle-agents/vectorize-store';
import { AiSdkEmbedder, VectorRetriever } from '@kuralle-agents/rag';
import { createWorkersAI } from 'workers-ai-provider';

interface Env {
  VECTORIZE: VectorizeIndex;
  AI: Ai;
}

export default {
  async fetch(request: Request, env: Env) {
    const workersai = createWorkersAI({ binding: env.AI });
    const vectorStore = new CloudflareVectorizeStore({ index: env.VECTORIZE });
    const embedder = new AiSdkEmbedder({
      model: workersai.textEmbeddingModel('@cf/baai/bge-m3'),
    });
    const retriever = new VectorRetriever({ store: vectorStore, embedder, indexName: 'docs', topK: 5 });
    // ...
  },
};
```

```toml
# wrangler.toml
[ai]
binding = "AI"

[[vectorize]]
binding = "VECTORIZE"
index_name = "docs"
```

The Vectorize index dimension must match the embedding model
(`@cf/baai/bge-m3` → 1024):

```bash
npx wrangler vectorize create docs --dimensions=1024 --metric=cosine
```

Any other AI SDK embedding provider (OpenAI, Google, Cohere) plugs into
`AiSdkEmbedder` the same way when you need a specific model — at the cost of a
cross-internet API call per embedding and a provider key. Whichever model you
choose, configure `RagPipeline`'s `manifest` (see `@kuralle-agents/rag`) so the
index is locked to the model that built it — mixing embedding models in one
index silently corrupts relevance.

Use `createVectorRetrievalTool` from `@kuralle-agents/tools` to attach this retriever as an agent tool.

## Related

- [`@kuralle-agents/rag`](https://www.npmjs.com/package/@kuralle-agents/rag) — `VectorStoreCore` interface, retrievers, embedders.
- [`@kuralle-agents/tools`](https://www.npmjs.com/package/@kuralle-agents/tools) — `createVectorRetrievalTool`.
- [`@kuralle-agents/cf-agent`](https://www.npmjs.com/package/@kuralle-agents/cf-agent) — Cloudflare Durable Objects agent integration.
