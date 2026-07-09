# @kuralle-agents/tools

Pre-built AI SDK tools for grounded retrieval and answering in Kuralle agents.

## Install

```bash
npm install @kuralle-agents/tools
```

Peers: `@kuralle-agents/core @kuralle-agents/rag ai@^6 zod`.

## What it does

Three tools you attach directly to a `defineAgent` call: CAG retrieve, CAG answer, and vector similarity retrieval.

**Key exports:**

- **`createCagTool`** — retrieves relevant chunks from a `KnowledgeSource` (Chunk-and-Generate retrieve step).
- **`createCagAnswerTool`** — retrieves chunks and synthesizes a grounded answer in one tool call.
- **`createVectorRetrievalTool`** — similarity search over a `VectorStoreCore` with optional metadata filtering.

## Usage

```ts
import { defineAgent, createRuntime, buildToolSet } from '@kuralle-agents/core';
import { createCagTool, createCagAnswerTool } from '@kuralle-agents/tools';
import { createStaticKnowledgeSource, createMarkdownChunker } from '@kuralle-agents/rag';
import { openai } from '@ai-sdk/openai';

const source = createStaticKnowledgeSource({
  content: '# Refund Policy\nRefunds are available within 30 days.',
  chunker: createMarkdownChunker(),
});

const retrieveTool = createCagTool({ source, topK: 5 });
const answerTool = createCagAnswerTool({ source, model: openai('gpt-4o-mini') });

const agent = defineAgent({
  id: 'support',
  instructions: 'Answer questions using the provided knowledge.',
  model: openai('gpt-4o-mini'),
  tools: { retrieve: retrieveTool, answer: answerTool },
});
```

## Vector retrieval

```ts
import { createVectorRetrievalTool } from '@kuralle-agents/tools';
import { InMemoryVectorStore, AiSdkEmbedder } from '@kuralle-agents/rag';
import { openai } from '@ai-sdk/openai';

const vectorStore = new InMemoryVectorStore();
const embedder = new AiSdkEmbedder({ model: openai.embedding('text-embedding-3-small') });

const vectorTool = createVectorRetrievalTool({
  vectorStore,
  embedder,
  topK: 5,
  indexName: 'docs',
});
```

## Related

- [`@kuralle-agents/core`](https://www.npmjs.com/package/@kuralle-agents/core) — runtime and agent primitives.
- [`@kuralle-agents/rag`](https://www.npmjs.com/package/@kuralle-agents/rag) — chunkers, retrievers, vector stores.
