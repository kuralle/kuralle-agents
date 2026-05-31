# RAG Primitives Reference

All interfaces and implementations in `@kuralle-agents/rag`.

---

## Embedder

Converts text to dense vector representations.

```ts
interface Embedder {
  embed(text: string): Promise<readonly number[]>;
  embedMany(texts: string[]): Promise<readonly (readonly number[])[]>;
  readonly dimension?: number;
}
```

### AiSdkEmbedder

Default implementation backed by the Vercel AI SDK. Supports any provider registered with the SDK.

```ts
import { openai } from '@ai-sdk/openai';
import { AiSdkEmbedder } from '@kuralle-agents/rag';

const embedder = new AiSdkEmbedder({
  model: openai.embedding('text-embedding-3-small'),
});

const vector = await embedder.embed('Hello world');
// vector.length === 1536

const vectors = await embedder.embedMany(['Hello', 'World']);
// vectors.length === 2

console.log(embedder.dimension); // 1536 (cached after first call)
```

### Custom Embedder

Implement the `Embedder` interface for any provider:

```ts
import type { Embedder } from '@kuralle-agents/rag';

class OllamaEmbedder implements Embedder {
  readonly dimension = 768;

  async embed(text: string): Promise<readonly number[]> {
    const res = await fetch('http://localhost:11434/api/embeddings', {
      method: 'POST',
      body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
    });
    const { embedding } = await res.json();
    return embedding;
  }

  async embedMany(texts: string[]): Promise<readonly (readonly number[])[]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }
}
```

---

## VectorStore

Persistent vector storage and similarity search. The primary extension point for third-party vector database integrations.

```ts
interface VectorStore {
  // Required
  upsert(indexName: string, entries: VectorEntry[]): Promise<void>;
  query(indexName: string, params: VectorQueryParams): Promise<VectorQueryResult[]>;
  createIndex(params: CreateIndexParams): Promise<void>;
  listIndexes(): Promise<string[]>;
  deleteIndex(indexName: string): Promise<void>;

  // Optional
  deleteVectors?(indexName: string, params: { ids?: string[]; filter?: VectorFilter }): Promise<void>;
  describeIndex?(indexName: string): Promise<IndexStats>;
}
```

### Supporting Types

```ts
interface VectorEntry {
  id: string;
  vector: readonly number[];
  metadata?: Record<string, unknown>;
  document?: string;  // original text, stored for retrieval
}

interface VectorQueryParams {
  queryVector: readonly number[];
  topK?: number;           // default: 10
  filter?: VectorFilter;
  includeVectors?: boolean; // default: false
  includeDocuments?: boolean; // default: true
}

interface VectorQueryResult {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
  document?: string;
  vector?: readonly number[];
}

interface CreateIndexParams {
  indexName: string;
  dimension: number;
  metric?: 'cosine' | 'euclidean' | 'dotproduct'; // default: 'cosine'
}

interface IndexStats {
  dimension: number;
  count: number;
  metric: 'cosine' | 'euclidean' | 'dotproduct';
}
```

### VectorFilter (MongoDB-style DSL)

Metadata filters use MongoDB-style operators. Each provider translates this to its native query syntax.

```ts
type VectorFilter =
  | VectorFilterCondition
  | { $and: VectorFilter[] }
  | { $or: VectorFilter[] }
  | { $not: VectorFilter };

// Operators: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $exists
```

Examples:

```ts
// Equality
const filter = { category: 'policy' };

// Comparison
const filter = { year: { $gte: 2024 } };

// Set membership
const filter = { region: { $in: ['EU', 'US'] } };

// Logical
const filter = { $and: [{ category: 'policy' }, { region: 'EU' }] };

// Negation
const filter = { $not: { status: 'archived' } };
```

### InMemoryVectorStore

Development/testing store with brute-force similarity search. Not for production.

```ts
import { InMemoryVectorStore } from '@kuralle-agents/rag';

const store = new InMemoryVectorStore();

await store.createIndex({ indexName: 'docs', dimension: 3, metric: 'cosine' });

await store.upsert('docs', [
  { id: 'a', vector: [1, 0, 0], metadata: { type: 'faq' }, document: 'FAQ text...' },
  { id: 'b', vector: [0, 1, 0], metadata: { type: 'policy' }, document: 'Policy text...' },
]);

const results = await store.query('docs', {
  queryVector: [0.9, 0.1, 0],
  topK: 1,
  filter: { type: 'faq' },
});
// [{ id: 'a', score: 0.99, document: 'FAQ text...', metadata: { type: 'faq' } }]

const stats = await store.describeIndex('docs');
// { dimension: 3, count: 2, metric: 'cosine' }

await store.deleteVectors('docs', { ids: ['a'] });
await store.deleteIndex('docs');
```

### Provider Packages

Each vector database is a separate npm package implementing `VectorStore`:

| Package | Database | Install |
|---------|----------|---------|
| `@kuralle-agents/vector-pg` | PostgreSQL + pgvector | `bun add @kuralle-agents/vector-pg pg` |
| `@kuralle-agents/vector-redis` | Redis + Redis Search | `bun add @kuralle-agents/vector-redis` |

---

## Retriever

Retrieves relevant content given a query. The generalized interface that all retrieval strategies implement.

```ts
interface Retriever {
  retrieve(query: string, options?: RetrievalOptions): Promise<RetrievalResult[]>;
}

interface RetrievalOptions {
  topK?: number;
  filter?: VectorFilter;
  hint?: string;
}

interface RetrievalResult {
  id: string;
  text: string;
  score?: number;
  metadata?: Record<string, unknown>;
  sourceId?: string;
  reason?: string;
}
```

### VectorRetriever

Embeds the query and searches a `VectorStore`.

```ts
import { VectorRetriever } from '@kuralle-agents/rag';

const retriever = new VectorRetriever({
  vectorStore,
  embedder,
  indexName: 'docs',
  topK: 10,
});

const results = await retriever.retrieve('refund policy', {
  topK: 5,
  filter: { region: 'EU' },
});
```

### HybridRetriever

Combines multiple vector retrievers using reciprocal rank fusion (RRF). Useful for searching across multiple indexes or combining vector similarity with keyword search.

```ts
import { VectorRetriever, HybridRetriever } from '@kuralle-agents/rag';

const docsRetriever = new VectorRetriever({
  vectorStore, embedder, indexName: 'docs',
});

const faqRetriever = new VectorRetriever({
  vectorStore, embedder, indexName: 'faq',
});

const hybrid = new HybridRetriever({
  sources: [
    { retriever: docsRetriever, weight: 0.6 },
    { retriever: faqRetriever, weight: 0.4 },
  ],
  topK: 10,
  k: 60, // RRF constant (default: 60)
});

const results = await hybrid.retrieve('How do I cancel?');
```

RRF does not require score normalization across retrievers, making it safe to combine retrievers with different scoring scales.

### Custom Retriever

Implement the `Retriever` interface for any retrieval backend:

```ts
import type { Retriever, RetrievalResult, RetrievalOptions } from '@kuralle-agents/rag';

class ElasticsearchRetriever implements Retriever {
  async retrieve(query: string, options?: RetrievalOptions): Promise<RetrievalResult[]> {
    const response = await esClient.search({
      index: 'docs',
      body: { query: { match: { content: query } }, size: options?.topK ?? 10 },
    });
    return response.hits.hits.map(hit => ({
      id: hit._id,
      text: hit._source.content,
      score: hit._score,
      metadata: hit._source.metadata,
    }));
  }
}
```

---

## Reranker

Post-retrieval refinement. Takes initial results and reorders them by a more expensive relevance signal.

```ts
interface Reranker {
  rerank(query: string, results: RetrievalResult[], options?: RerankerOptions): Promise<RetrievalResult[]>;
}

interface RerankerOptions {
  topK?: number;
}
```

### LLMReranker

Uses a language model to score each candidate on a 0-10 scale.

```ts
import { LLMReranker } from '@kuralle-agents/rag';

const reranker = new LLMReranker({
  model: openai('gpt-4o-mini'),
  topK: 5,
  includeReasons: true,    // add reason field to results
  candidateMaxChars: 1500, // truncate long documents
});

const initial = await retriever.retrieve('refund policy', { topK: 20 });
const reranked = await reranker.rerank('refund policy', initial, { topK: 5 });

console.log(reranked[0].score);  // 0.0 - 1.0 (normalized from 0-10)
console.log(reranked[0].reason); // "Directly addresses the refund window..."
```

### Custom Reranker

```ts
import type { Reranker, RetrievalResult, RerankerOptions } from '@kuralle-agents/rag';

class CohereReranker implements Reranker {
  async rerank(query: string, results: RetrievalResult[], options?: RerankerOptions): Promise<RetrievalResult[]> {
    const response = await cohere.rerank({
      query,
      documents: results.map(r => r.text),
      topN: options?.topK ?? 5,
    });
    return response.results.map(r => ({
      ...results[r.index],
      score: r.relevanceScore,
    }));
  }
}
```

---

## Chunker

Splits text into chunks. Shared by both CAG and vector RAG paths.

```ts
interface Chunker {
  chunk(text: string, options?: ChunkOptions): KnowledgeChunk[];
}

interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
}
```

### Built-in Chunkers

```ts
import { createMarkdownChunker, createRecursiveChunker } from '@kuralle-agents/rag';

// Markdown-aware: splits on ## headings, respects section structure
const mdChunker = createMarkdownChunker({ maxChars: 1200, overlapChars: 100 });

// Simple: splits at character boundaries with overlap
const recChunker = createRecursiveChunker({ maxChars: 1200, overlapChars: 100 });

const chunks = mdChunker.chunk('## Section One\nContent...\n## Section Two\nMore...');
```

---

## RagPipeline

Convenience class that wires `Embedder` + `VectorStore` + `Chunker` + optional `Reranker` into a single ingestion + retrieval pipeline. Implements the `Retriever` interface.

```ts
import {
  AiSdkEmbedder,
  InMemoryVectorStore,
  RagPipeline,
  LLMReranker,
  createRecursiveChunker,
} from '@kuralle-agents/rag';

const pipeline = new RagPipeline({
  embedder: new AiSdkEmbedder({ model: openai.embedding('text-embedding-3-small') }),
  vectorStore: new InMemoryVectorStore(),
  chunker: createRecursiveChunker({ maxChars: 1200 }),
  indexName: 'my-docs',
  reranker: new LLMReranker({ model: openai('gpt-4o-mini'), topK: 5 }),
  topK: 10,
  metric: 'cosine',
  batchSize: 100, // batch embedding calls (default: 100)
});

// Ingest
await pipeline.ingest([
  { id: 'doc1', text: 'Document content...', metadata: { source: 'wiki' } },
]);

// Retrieve (implements Retriever interface)
const results = await pipeline.retrieve('search query', { topK: 5 });
```

`ensureIndex()` is called automatically by `ingest()`. It creates the vector index if it doesn't exist, probing the embedder for dimension.

---

## Document and DocumentLoader

```ts
interface Document {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

interface DocumentLoader {
  load(): Promise<Document[]>;
}
```

`Document` is the input to `RagPipeline.ingest()`. `DocumentLoader` is an interface for source-specific loading (file, URL, API). Built-in loader implementations are planned for a future release.

---

## CAG Types

These types power the CAG (Chunk and Generate) pattern -- static knowledge sources with LLM-based ranking:

| Type | Description |
|------|-------------|
| `KnowledgeChunk` | `{ id, text, meta? }` |
| `KnowledgeSource` | `{ id, name, getChunks(), dumpContent?() }` |
| `Chunker` | CAG chunker returning `KnowledgeChunk[]` |
| `ChunkOptions` | `{ maxChars?, overlapChars? }` |
| `RetrievalHit` | `{ sourceId, chunkId, rank, score?, reason? }` |
| `KnowledgeRetriever` | CAG retriever operating on `KnowledgeSource[]` |
| `LLMRetrieverOptions` | Config for `createLLMRetriever` |

Factory functions: `createStaticKnowledgeSource`, `createMarkdownChunker`, `createRecursiveChunker`, `createLLMRetriever`.
