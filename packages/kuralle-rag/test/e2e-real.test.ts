/**
 * Real E2E Test — full production pipeline with LanceDB + Gemini Embedding 2.
 *
 * Uses REAL components only:
 * - PdfLoader → real PDF ("Patterns for Building AI Agents")
 * - MarkdownLoader → real .md files (Acme Corp policies + products)
 * - LanceDB → persistent vector storage
 * - Gemini Embedding 2 (gemini-embedding-exp-03-07) → real embeddings
 * - BM25Index + FusionRetriever → hybrid search
 * - CohereReranker → cross-encoder reranking
 * - RetrievalCache → semantic cache (dual-index: query + document)
 *
 * Requires: GOOGLE_GENERATIVE_AI_API_KEY
 * Optional: COHERE_API_KEY
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { google } from '@ai-sdk/google';
import {
  AiSdkEmbedder,
  RagPipeline,
  BM25Index,
  FusionRetriever,
  CohereReranker,
  RetrievalCache,
  createTokenChunker,
} from '../src/index.js';
import { LanceDBVectorStore } from '../../kuralle-lancedb-store/src/index.js';
import { PdfLoader, MarkdownLoader } from '../../kuralle-rag-loaders/src/index.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(currentDir, '..', '..', '..');

const PDF_PATH = join(currentDir, 'fixtures', 'sample.pdf');
const MD_POLICIES = join(repoRoot, 'apps/playground/rag-demo/knowledge/policies.md');
const MD_PRODUCTS = join(repoRoot, 'apps/playground/rag-demo/knowledge/products.md');

const fixturesReady =
  existsSync(PDF_PATH) && existsSync(MD_POLICIES) && existsSync(MD_PRODUCTS);

// LanceDB data directory (ephemeral)
const LANCEDB_DIR = join(currentDir, '.lancedb-test-data');

// Check for API keys
const hasGoogle = !!process.env.GOOGLE_GENERATIVE_AI_API_KEY;
const hasCohere = !!process.env.COHERE_API_KEY;

if (!hasGoogle) {
  console.warn('⚠ GOOGLE_GENERATIVE_AI_API_KEY not set — skipping real E2E tests');
}
if (!fixturesReady) {
  console.warn('⚠ RAG E2E fixtures missing — skipping real E2E tests', {
    PDF_PATH,
    MD_POLICIES,
    MD_PRODUCTS,
  });
}

// Shared state
let allDocTexts: Array<{ id: string; text: string; metadata?: Record<string, unknown> }> = [];

// Gemini Embedding — free, high quality
// gemini-embedding-001 is stable GA; gemini-embedding-2-preview is the latest
const embedder = new AiSdkEmbedder({
  model: google.embedding('gemini-embedding-001'),
});

try { rmSync(LANCEDB_DIR, { recursive: true }); } catch {}
mkdirSync(LANCEDB_DIR, { recursive: true });

const lanceStore = new LanceDBVectorStore({ uri: LANCEDB_DIR });
const chunker = createTokenChunker({ defaults: { maxTokens: 256 } });
const bm25 = new BM25Index();

const pipeline = new RagPipeline({
  embedder,
  vectorStore: lanceStore,
  chunker,
  indexName: 'real-e2e',
  topK: 5,
});

describe.skipIf(!hasGoogle || !fixturesReady)('Real E2E Pipeline (LanceDB + Gemini Embedding 2)', () => {

  afterAll(() => {
    try { rmSync(LANCEDB_DIR, { recursive: true }); } catch {}
  });

  test('Step 1: PdfLoader extracts text from real PDF', async () => {
    const loader = new PdfLoader({ filePath: PDF_PATH });
    const docs = await loader.load();

    expect(docs.length).toBe(1);
    expect(docs[0].text.length).toBeGreaterThan(100);
    console.log(`  PDF: ${docs[0].text.length} chars, ${docs[0].metadata?.pages} pages`);
    console.log(`  Preview: "${docs[0].text.slice(0, 120).replace(/\n/g, ' ')}..."`);

    allDocTexts.push({
      id: 'pdf-agents',
      text: docs[0].text.slice(0, 5000),
      metadata: { source: 'pdf', type: 'whitepaper' },
    });
  }, 10_000);

  test('Step 2: MarkdownLoader loads real .md files', async () => {
    const policyLoader = new MarkdownLoader({ filePath: MD_POLICIES, splitByHeading: true });
    const productLoader = new MarkdownLoader({ filePath: MD_PRODUCTS, splitByHeading: true });

    const policyDocs = await policyLoader.load();
    const productDocs = await productLoader.load();

    for (const d of policyDocs) {
      allDocTexts.push({ id: `policy:${d.id}`, text: d.text, metadata: { source: 'policies.md' } });
    }
    for (const d of productDocs) {
      allDocTexts.push({ id: `product:${d.id}`, text: d.text, metadata: { source: 'products.md' } });
    }

    console.log(`  Policies: ${policyDocs.length} sections, Products: ${productDocs.length} sections`);
    console.log(`  Total documents: ${allDocTexts.length}`);
  }, 10_000);

  test('Step 3: Ingest into LanceDB with Gemini embeddings', async () => {
    const documents = allDocTexts.map(d => ({ id: d.id, text: d.text, metadata: d.metadata }));
    await pipeline.ingest(documents);

    const stats = await lanceStore.describeIndex?.('real-e2e');
    expect(stats!.count).toBeGreaterThan(0);
    console.log(`  LanceDB: ${stats!.count} vectors (dim=${stats!.dimension})`);
  }, 60_000);

  test('Step 4: Populate BM25 index', () => {
    for (const doc of allDocTexts) {
      const chunks = chunker.chunk(doc.text);
      bm25.add(chunks.map(c => ({ id: `${doc.id}:${c.id}`, text: c.text })));
    }
    console.log(`  BM25: ${bm25.size} documents indexed`);
  });

  test('Step 5: Hybrid search — "return and refund policy"', async () => {
    const fusion = new FusionRetriever({
      bm25, vectorStore: lanceStore, embedder, indexName: 'real-e2e',
      topK: 5, bm25Weight: 0.3,
    });

    const results = await fusion.retrieve('What is the return and refund policy?', { includeEmbeddings: true });
    expect(results.length).toBeGreaterThan(0);

    console.log(`\n  Query: "What is the return and refund policy?"`);
    for (const r of results) {
      console.log(`    [${r.score?.toFixed(3)}] ${r.text.slice(0, 80).replace(/\n/g, ' ')}...`);
    }
  }, 15_000);

  test('Step 6: Hybrid search — PDF content about AI agents', async () => {
    const fusion = new FusionRetriever({
      bm25, vectorStore: lanceStore, embedder, indexName: 'real-e2e', topK: 3,
    });

    const results = await fusion.retrieve('agent capabilities and design patterns');
    expect(results.length).toBeGreaterThan(0);

    console.log(`\n  Query: "agent capabilities and design patterns"`);
    for (const r of results) {
      console.log(`    [${r.score?.toFixed(3)}] ${r.text.slice(0, 80).replace(/\n/g, ' ')}...`);
    }
  }, 15_000);

  test('Step 7: CohereReranker reranks results', async () => {
    if (!hasCohere) { console.log('  ⚠ COHERE_API_KEY not set — skipping'); return; }

    const fusion = new FusionRetriever({
      bm25, vectorStore: lanceStore, embedder, indexName: 'real-e2e', topK: 10,
    });
    const reranker = new CohereReranker({ topK: 3 });

    const query = 'How much does shipping cost and how long does it take?';
    const candidates = await fusion.retrieve(query);
    const reranked = await reranker.rerank(query, candidates, { topK: 3 });

    expect(reranked.length).toBeGreaterThan(0);
    console.log(`\n  Cohere: ${candidates.length} → ${reranked.length} reranked`);
    for (const r of reranked) {
      console.log(`    [${r.score?.toFixed(3)}] ${r.text.slice(0, 80).replace(/\n/g, ' ')}...`);
    }
  }, 20_000);

  test('Step 8: RetrievalCache — query-indexed dual cache', async () => {
    const cache = new RetrievalCache({ similarityThreshold: 0.80 });
    const fusion = new FusionRetriever({
      bm25, vectorStore: lanceStore, embedder, indexName: 'real-e2e', topK: 5,
    });

    // Q1: cache miss → search → populate with query embedding
    const q1 = 'What is the warranty policy?';
    const q1Embed = await embedder.embed(q1);
    expect(cache.lookup(q1Embed, 3).length).toBe(0);

    const results = await fusion.retrieve(q1, { includeEmbeddings: true });
    cache.populate(results, q1Embed); // Pass query embedding for query-indexed cache
    console.log(`\n  Q1: "${q1}" → ${results.length} results (MISS → cache=${cache.size})`);

    // Same query — should hit via query index (query-to-query similarity ≈ 1.0)
    const hit1 = cache.lookup(q1Embed, 3);
    expect(hit1.length).toBeGreaterThan(0);
    console.log(`  Q1 replay: HIT → ${hit1.length} results ✓`);

    // Similar query — should hit via query index (high query-to-query similarity)
    const q2 = 'Tell me about the warranty and guarantee';
    const q2Embed = await embedder.embed(q2);
    const hit2 = cache.lookup(q2Embed, 3);
    console.log(`  Q2: "${q2}" → ${hit2.length > 0 ? 'HIT' : 'MISS'} (${hit2.length} results)`);

    if (hit2.length > 0) {
      console.log(`  ✓ Query-indexed semantic cache works with Gemini embeddings`);
    } else {
      console.log(`  ✗ Similar query missed — cosine may be below 0.80 threshold`);
    }
  }, 20_000);

  test('Step 9: LanceDB persistence — data survives restart', async () => {
    const store2 = new LanceDBVectorStore({ uri: LANCEDB_DIR });
    const stats = await store2.describeIndex?.('real-e2e');
    expect(stats!.count).toBeGreaterThan(0);

    const queryVec = await embedder.embed('refund policy');
    const results = await store2.query('real-e2e', {
      queryVector: Array.from(queryVec),
      topK: 3,
      includeDocuments: true,
    });
    expect(results.length).toBeGreaterThan(0);
    console.log(`\n  Reopened LanceDB: ${stats!.count} vectors, query returned ${results.length} results`);
    console.log(`  ✓ Persistence verified`);
  }, 15_000);
});
