# RedisVectorStore Guide

`RedisVectorStore` is a `VectorStore` implementation backed by Redis with the Redis Search module. It uses HNSW indexing for fast approximate nearest neighbor search.

## Prerequisites

- Redis 7+ with Redis Search module, or Redis Stack

```bash
# macOS
brew install redis-stack-server
redis-stack-server --daemonize yes

# Docker
docker run -d --name redis-stack -p 6379:6379 redis/redis-stack-server
```

## Install

```bash
bun add @kuralle-agents/redis-store @kuralle-agents/rag redis
```

## Usage

```ts
import { createClient } from 'redis';
import { RedisVectorStore } from '@kuralle-agents/redis-store';

const client = createClient({ url: 'redis://localhost:6379' });
await client.connect();

const store = new RedisVectorStore({ client: client as any });
```

### With ioredis

```ts
import Redis from 'ioredis';
import { RedisVectorStore } from '@kuralle-agents/redis-store';

const client = new Redis('redis://localhost:6379');
const store = new RedisVectorStore({ client: client as any });
```

### Create an Index

```ts
await store.createIndex({
  indexName: 'docs',
  dimension: 1536,
  metric: 'cosine',  // 'cosine' | 'euclidean' | 'dotproduct'
});
```

This runs `FT.CREATE` with a VECTOR HNSW field.

### Upsert Vectors

```ts
await store.upsert('docs', [
  {
    id: 'chunk-1',
    vector: embedding,
    metadata: { category: 'faq', source: 'help.md' },
    document: 'Original text of the chunk...',
  },
]);
```

Each entry is stored as a Redis Hash at key `{prefix}:{indexName}:{id}`.

### Query

```ts
const results = await store.query('docs', {
  queryVector: queryEmbedding,
  topK: 10,
  includeDocuments: true,
});

for (const r of results) {
  console.log(`${r.id}: score=${r.score.toFixed(3)} text="${r.document}"`);
}
```

### With RagPipeline

```ts
import { AiSdkEmbedder, RagPipeline, createMarkdownChunker } from '@kuralle-agents/rag';
import { RedisVectorStore } from '@kuralle-agents/redis-store';
import { openai } from '@ai-sdk/openai';
import { createClient } from 'redis';

const client = createClient({ url: 'redis://localhost:6379' });
await client.connect();

const pipeline = new RagPipeline({
  embedder: new AiSdkEmbedder({ model: openai.embedding('text-embedding-3-small') }),
  vectorStore: new RedisVectorStore({ client: client as any }),
  chunker: createMarkdownChunker({ maxChars: 1200 }),
  indexName: 'knowledge',
});

await pipeline.ingest([{ id: 'doc1', text: markdownContent }]);
const results = await pipeline.retrieve('search query');
```

## Key Layout

```
{prefix}:{indexName}:{id}     -- Hash (vector, metadata, document, id)
{prefix}:_registry            -- Hash (index metadata: dimension, metric)
{prefix}:{indexName}:idx      -- FT index name
```

Default prefix: `kuralle:vector`.

## Options

```ts
interface RedisVectorStoreOptions {
  client: RedisClientLike;   // node-redis, ioredis, or Upstash
  prefix?: string;           // default: 'kuralle:vector'
}
```

## Distance Metrics

| Metric | Redis Search Config | Score Conversion |
|--------|-------------------|------------------|
| `cosine` | `DISTANCE_METRIC COSINE` | `score = 1 - distance` |
| `euclidean` | `DISTANCE_METRIC L2` | `score = 1 - distance` |
| `dotproduct` | `DISTANCE_METRIC IP` | `score = 1 - distance` |

## Client Compatibility

`RedisVectorStore` uses the same `RedisClientLike` interface as `RedisSessionStore`. It works with:

- **node-redis** (`redis` package) -- via `sendCommand`
- **ioredis** -- via `call`
- **Upstash** -- via REST client (requires Redis Search support)

The store auto-detects which command interface is available.
