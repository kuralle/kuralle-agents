# Vector Retrieval Tool

`createVectorRetrievalTool` creates a Vercel AI SDK tool that wraps any `Retriever`. The LLM decides when to search.

## Basic Usage

```ts
import { createVectorRetrievalTool, RagPipeline } from '@kuralle-agents/rag';

const searchTool = createVectorRetrievalTool({
  retriever: pipeline, // any Retriever: RagPipeline, VectorRetriever, HybridRetriever
  topK: 10,
});

import { defineAgent } from '@kuralle-agents/core';

const agent = defineAgent({
  id: 'support',
  model: openai('gpt-4o'),
  instructions: 'Use search_knowledge for factual questions.',
  tools: { search_knowledge: searchTool },
});
```

## Agentic Filters

Enable `enableAgenticFilters` so the LLM can construct metadata filters at call time. Provide `filterableFields` to tell the LLM which fields exist.

```ts
const searchTool = createVectorRetrievalTool({
  retriever: pipeline,
  topK: 10,
  enableAgenticFilters: true,
  filterableFields: [
    { field: 'category', description: 'Document category', type: 'string', examples: ['policy', 'faq'] },
    { field: 'region', description: 'Geographic region', type: 'string', examples: ['EU', 'US'] },
    { field: 'year', description: 'Publication year', type: 'number' },
  ],
});
```

The LLM can now call the tool with:

```json
{
  "query": "refund policy",
  "filter": { "region": "EU", "year": { "$gte": 2024 } }
}
```

The filter is passed directly to the underlying `VectorStore.query()`.

## Static Filters (Tenant Isolation)

Use `staticFilter` for invariant constraints that the LLM cannot override. It is merged with any agentic filter via `$and`.

```ts
const searchTool = createVectorRetrievalTool({
  retriever: pipeline,
  topK: 10,
  staticFilter: { tenant_id: 'acme-corp' },
  enableAgenticFilters: true,
  filterableFields: [
    { field: 'category', description: 'Document category', type: 'string' },
  ],
});

// If the LLM calls: { query: "refund", filter: { category: "policy" } }
// Actual filter becomes: { $and: [{ tenant_id: "acme-corp" }, { category: "policy" }] }
```

## Options Reference

```ts
interface VectorRetrievalToolOptions {
  retriever: Retriever;
  topK?: number;                          // default: 10
  description?: string;                   // custom tool description
  enableAgenticFilters?: boolean;         // default: false
  filterableFields?: FilterableFieldDescriptor[];
  staticFilter?: VectorFilter;
}

interface FilterableFieldDescriptor {
  field: string;
  description: string;
  type: 'string' | 'number' | 'boolean' | 'string[]';
  examples?: (string | number | boolean)[];
}
```

## Output Format

The tool returns:

```ts
interface VectorRetrievalToolOutput {
  results: {
    id: string;
    text: string;
    score?: number;
    sourceId?: string;
    reason?: string;
  }[];
}
```
