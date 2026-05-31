/**
 * Ingest Acme Corp knowledge base into LanceDB + BM25.
 *
 * Usage: bun run scripts/ingest.ts
 *
 * Uses RETRIEVAL_DOCUMENT task type for document embeddings (Gap 2).
 * Outputs BM25 index and compiled knowledge for runtime use.
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, mkdirSync } from 'fs';
import { google } from '@ai-sdk/google';
import {
  AiSdkEmbedder,
  RagPipeline,
  BM25Index,
  createTokenChunker,
} from '@kuralle-agents/rag';
import { LanceDBVectorStore } from '@kuralle-agents/lancedb-store';
import { MarkdownLoader } from '@kuralle-agents/rag-loaders';

const currentDir = dirname(fileURLToPath(import.meta.url));
const projectDir = join(currentDir, '..');
const knowledgeDir = join(projectDir, 'knowledge');
const dataDir = join(projectDir, 'data');

mkdirSync(dataDir, { recursive: true });

// Ingestion-time embedder: RETRIEVAL_DOCUMENT task type
const docEmbedder = new AiSdkEmbedder({
  model: google.embedding('gemini-embedding-001'),
  providerOptions: { google: { taskType: 'RETRIEVAL_DOCUMENT' } },
});

const vectorStore = new LanceDBVectorStore({ uri: join(dataDir, 'lancedb') });
const chunker = createTokenChunker({ defaults: { maxTokens: 256 } });
const bm25 = new BM25Index();

const pipeline = new RagPipeline({
  embedder: docEmbedder,
  vectorStore,
  chunker,
  indexName: 'acme-kb',
  topK: 10,
});

async function main() {
  console.log('=== Acme Corp Knowledge Base Ingestion ===\n');

  // Load documents
  const policyLoader = new MarkdownLoader({
    filePath: join(knowledgeDir, 'policies.md'),
    splitByHeading: true,
  });
  const productLoader = new MarkdownLoader({
    filePath: join(knowledgeDir, 'products.md'),
    splitByHeading: true,
  });

  const policyDocs = await policyLoader.load();
  const productDocs = await productLoader.load();

  const allDocs = [
    ...policyDocs.map(d => ({
      id: `policy:${d.id}`,
      text: d.text,
      metadata: { source: 'policies', category: 'policy', ...d.metadata },
    })),
    ...productDocs.map(d => ({
      id: `product:${d.id}`,
      text: d.text,
      metadata: { source: 'products', category: 'product', ...d.metadata },
    })),
  ];

  console.log(`Loaded ${allDocs.length} documents (${policyDocs.length} policies, ${productDocs.length} products)`);

  // Ingest into LanceDB with RETRIEVAL_DOCUMENT embeddings
  console.log('Embedding with gemini-embedding-001 (RETRIEVAL_DOCUMENT task type)...');
  await pipeline.ingest(allDocs);

  const stats = await vectorStore.describeIndex?.('acme-kb');
  console.log(`LanceDB: ${stats?.count} vectors (dim=${stats?.dimension})`);

  // Build BM25 index
  const bm25Docs: Array<{ id: string; text: string; metadata?: Record<string, unknown> }> = [];
  for (const doc of allDocs) {
    const chunks = chunker.chunk(doc.text);
    for (const chunk of chunks) {
      bm25Docs.push({
        id: `${doc.id}:${chunk.id}`,
        text: chunk.text,
        metadata: doc.metadata,
      });
    }
  }
  bm25.add(bm25Docs);
  console.log(`BM25: ${bm25.size} documents indexed`);

  // Save BM25 docs for runtime loading
  writeFileSync(join(dataDir, 'bm25-docs.json'), JSON.stringify(bm25Docs));
  console.log(`Saved BM25 data to data/bm25-docs.json`);

  // Build compiled knowledge (Layer 1) — key facts for system prompt
  const compiled = `## Acme Corp Quick Reference

### Refund Policy
- Full refund within 30 days, 50% refund up to 60 days, none after 60 days.
- Digital products non-refundable after download access.
- EU customers: 14-day cooling-off period, first return shipping covered.

### Shipping
- Standard: 5-7 days, free over $50. Express: 1-2 days, $12.99. International: 10-21 days.

### Products
- Starter (Free): 3 projects, 1GB, community support.
- Pro ($29/mo or $290/yr): unlimited projects, 50GB, priority support, API (10k/mo).
- Enterprise (custom): unlimited everything, SLA, SSO, dedicated manager.
- Widget X100 ($149.99): physical device, 7" touchscreen, 1-year warranty.
- Cloud Backup ($4.99/mo): daily backups, 90-day retention, Pro/Enterprise only.

### Warranty
- 1-year limited warranty on physical products (manufacturing defects only).
- Extended warranty available within 30 days (extends to 3 years).`;

  writeFileSync(join(dataDir, 'compiled-knowledge.md'), compiled);
  console.log(`Saved compiled knowledge to data/compiled-knowledge.md`);

  console.log('\n✓ Ingestion complete. Run `bun run cli` to start chatting.');
}

main().catch(console.error);
