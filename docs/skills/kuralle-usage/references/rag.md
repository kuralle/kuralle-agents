# RAG Package (80/20)

## What it is

`@kuralle-agents/rag` is for retriever primitives and knowledge sources. Use when you need lightweight retrieval without external infra.

## Core pieces

- `createStaticKnowledgeSource`
- `createLLMRetriever`

## Basic usage

```ts
import { openai } from '@ai-sdk/openai';
import { createStaticKnowledgeSource, createLLMRetriever } from '@kuralle-agents/rag';

const source = createStaticKnowledgeSource({
  id: 'support-pack',
  name: 'Support Pack',
  content: 'Refunds: 30 days. Cancellations: anytime.'
});

const retriever = createLLMRetriever({
  model: openai('gpt-4o-mini') as any,
  topK: 4,
});
```

## Where to read more

- `node_modules/@kuralle-agents/rag/README.md`
