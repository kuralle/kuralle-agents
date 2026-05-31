/**
 * RAG pipeline setup -- vector search over Acme Corp knowledge base.
 *
 * Supports three vector stores, switchable via VECTOR_STORE env var:
 *   - "memory" (default) -- InMemoryVectorStore, no external deps
 *   - "pg"               -- PgVectorStore, requires PostgreSQL + pgvector
 *   - "redis"            -- RedisVectorStore, requires Redis + Redis Search
 *
 * The rest of the code (agent, server, CLI) is identical regardless
 * of which store is used. The VectorStore interface is the boundary.
 */

import { openai } from '@ai-sdk/openai';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  AiSdkEmbedder,
  InMemoryVectorStore,
  RagPipeline,
  createMarkdownChunker,
  type VectorStoreCore as VectorStore,
  type Document,
} from '@kuralle-agents/rag';

const currentDir = dirname(fileURLToPath(import.meta.url));

// -- Embedder & Chunker (shared across all stores) --

export const embedder = new AiSdkEmbedder({
  model: openai.embedding('text-embedding-3-small'),
});

export const chunker = createMarkdownChunker({
  maxChars: 1200,
  overlapChars: 100,
});

// -- Vector Store (selected by VECTOR_STORE env var) --

async function createVectorStore(): Promise<VectorStore> {
  const storeType = process.env.VECTOR_STORE ?? 'memory';

  switch (storeType) {
    case 'pg': {
      const pg = await import('pg');
      const { PgVectorStore } = await import('@kuralle-agents/postgres-store');

      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) {
        throw new Error('DATABASE_URL is required when VECTOR_STORE=pg');
      }

      const pool = new pg.default.Pool({ connectionString });
      console.log(`[store] PostgreSQL (pgvector) -- ${connectionString.split('@')[1] ?? connectionString}`);
      return new PgVectorStore({ client: pool });
    }

    case 'redis': {
      const redis = await import('redis');
      const { RedisVectorStore } = await import('@kuralle-agents/redis-store');

      const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
      const client = redis.createClient({ url });
      await client.connect();
      console.log(`[store] Redis (Redis Search) -- ${url}`);
      return new RedisVectorStore({ client: client as any });
    }

    case 'memory':
    default:
      console.log('[store] In-memory (development only)');
      return new InMemoryVectorStore();
  }
}

// -- Pipeline --

export const vectorStore = await createVectorStore();

export const ragPipeline = new RagPipeline({
  embedder,
  vectorStore,
  chunker,
  indexName: 'acme-kb',
});

// -- Ingestion --

export async function ingestKnowledge(): Promise<void> {
  const knowledgeDir = join(currentDir, 'knowledge');

  const documents: Document[] = [
    {
      id: 'policies',
      text: readFileSync(join(knowledgeDir, 'policies.md'), 'utf-8'),
      metadata: { source: 'policies.md', category: 'policy' },
    },
    {
      id: 'products',
      text: readFileSync(join(knowledgeDir, 'products.md'), 'utf-8'),
      metadata: { source: 'products.md', category: 'product' },
    },
  ];

  console.log(`Ingesting ${documents.length} documents...`);
  await ragPipeline.ingest(documents);

  const stats = await vectorStore.describeIndex?.('acme-kb');
  console.log(`Indexed ${stats?.count ?? '?'} vectors (dim=${stats?.dimension ?? '?'})`);
}
