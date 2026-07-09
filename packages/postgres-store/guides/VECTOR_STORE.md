# PgVectorStore Guide

`PgVectorStore` is a `VectorStore` implementation backed by PostgreSQL with the pgvector extension. It uses HNSW indexes for fast approximate nearest neighbor search.

## Prerequisites

- PostgreSQL 15+
- pgvector extension

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

## Install

```bash
bun add @kuralle-agents/postgres-store @kuralle-agents/rag pg
```

## Usage

```ts
import pg from 'pg';
import { PgVectorStore } from '@kuralle-agents/postgres-store';

const pool = new pg.Pool({
  connectionString: 'postgresql://localhost:5432/mydb',
});

const store = new PgVectorStore({ client: pool });
```

### Create an Index

```ts
await store.createIndex({
  indexName: 'docs',
  dimension: 1536,   // must match your embedding model
  metric: 'cosine',  // 'cosine' | 'euclidean' | 'dotproduct'
});
```

This creates a table `kuralle_vectors_docs` with a `vector(1536)` column and an HNSW index.

### Upsert Vectors

```ts
await store.upsert('docs', [
  {
    id: 'chunk-1',
    vector: embedding,           // number[] from your embedder
    metadata: { category: 'faq', source: 'help.md' },
    document: 'Original text of the chunk...',
  },
]);
```

### Query

```ts
const results = await store.query('docs', {
  queryVector: queryEmbedding,
  topK: 10,
  filter: { category: 'faq' },  // MongoDB-style metadata filter
  includeDocuments: true,
});

for (const r of results) {
  console.log(`${r.id}: score=${r.score.toFixed(3)} text="${r.document}"`);
}
```

### Metadata Filters

Filters translate to SQL WHERE clauses on the JSONB `metadata` column.

```ts
// Equality
{ category: 'policy' }

// Comparison
{ year: { $gte: 2024 } }

// Set membership
{ region: { $in: ['EU', 'US'] } }

// Logical
{ $and: [{ category: 'policy' }, { region: 'EU' }] }
{ $or: [{ type: 'faq' }, { type: 'guide' }] }
{ $not: { status: 'archived' } }

// Field existence
{ priority: { $exists: true } }
```

### With RagPipeline

```ts
import { AiSdkEmbedder, RagPipeline, createMarkdownChunker } from '@kuralle-agents/rag';
import { PgVectorStore } from '@kuralle-agents/postgres-store';
import { openai } from '@ai-sdk/openai';

const pipeline = new RagPipeline({
  embedder: new AiSdkEmbedder({ model: openai.embedding('text-embedding-3-small') }),
  vectorStore: new PgVectorStore({ client: pool }),
  chunker: createMarkdownChunker({ maxChars: 1200 }),
  indexName: 'knowledge',
});

await pipeline.ingest([{ id: 'doc1', text: markdownContent }]);
const results = await pipeline.retrieve('search query');
```

## Schema

Each index creates a table:

```sql
CREATE TABLE kuralle_vectors_{indexName} (
  id         TEXT PRIMARY KEY,
  vector     vector(N),
  metadata   JSONB,
  document   TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- HNSW index for fast ANN search
CREATE INDEX ... USING hnsw (vector {ops_class});
```

Index metadata is tracked in a registry table:

```sql
CREATE TABLE kuralle_vectors_registry (
  index_name TEXT PRIMARY KEY,
  dimension  INTEGER,
  metric     TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Options

```ts
interface PgVectorStoreOptions {
  client: { query(text: string, params?: unknown[]): Promise<QueryResult> };
  tablePrefix?: string;  // default: 'kuralle_vectors'
}
```

## Distance Metrics

| Metric | pgvector Operator | Use Case |
|--------|-------------------|----------|
| `cosine` | `<=>` | General purpose, normalized vectors |
| `euclidean` | `<->` | When vector magnitude matters |
| `dotproduct` | `<#>` | Pre-normalized vectors, faster |
