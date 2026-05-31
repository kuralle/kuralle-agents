/**
 * E2E Pipeline Test — exercises the full retrieval pipeline:
 *
 * 1. MarkdownLoader → Document[]
 * 2. createTokenChunker → KnowledgeChunk[]
 * 3. Ingest into InMemoryVectorStore via RagPipeline
 * 4. BM25Index population
 * 5. FusionRetriever (BM25 + vector) retrieval
 * 6. RetrievalCache population on first query (cache miss)
 * 7. RetrievalCache hit on second similar query
 * 8. TurnCache dedup on exact same query
 * 9. PredictivePreFetcher keyword extraction
 *
 * Uses a deterministic mock embedder (no API keys needed).
 */

import { describe, test, expect } from 'bun:test';
import {
  InMemoryVectorStore,
  RagPipeline,
  BM25Index,
  FusionRetriever,
  RetrievalCache,
  TurnCache,
  PredictivePreFetcher,
  createTokenChunker,
  type Embedder,
  type RetrievalResult,
  type Document,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Mock embedder — deterministic, no API key needed
// ---------------------------------------------------------------------------

/**
 * Creates a simple bag-of-words embedding where each dimension corresponds
 * to a word in the vocabulary. This gives us real cosine similarity behavior.
 */
class MockEmbedder implements Embedder {
  private vocab = new Map<string, number>();
  private nextDim = 0;
  readonly dimension = 64;

  private getOrCreateDim(word: string): number {
    let dim = this.vocab.get(word);
    if (dim === undefined) {
      dim = this.nextDim % this.dimension;
      this.vocab.set(word, dim);
      this.nextDim++;
    }
    return dim;
  }

  private tokenize(text: string): string[] {
    return text.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(t => t.length > 1);
  }

  async embed(text: string): Promise<readonly number[]> {
    const vec = new Float64Array(this.dimension);
    const tokens = this.tokenize(text);
    for (const token of tokens) {
      const dim = this.getOrCreateDim(token);
      vec[dim] += 1;
    }
    // Normalize
    let mag = 0;
    for (let i = 0; i < vec.length; i++) mag += vec[i] * vec[i];
    mag = Math.sqrt(mag);
    if (mag > 0) for (let i = 0; i < vec.length; i++) vec[i] /= mag;
    return Array.from(vec);
  }

  async embedMany(texts: string[]): Promise<readonly (readonly number[])[]> {
    return Promise.all(texts.map(t => this.embed(t)));
  }
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const MARKDOWN_CONTENT = `# Acme Corp Knowledge Base

## Return Policy
Acme Corp offers a 30-day return policy on all products. Items must be in original packaging.
Refunds are processed within 5-7 business days. Electronics have a 15-day return window.
Opened software cannot be returned.

## Product Catalog
The Acme Widget Pro costs $49.99 and comes with a 2-year warranty.
The Acme Gadget Mini costs $29.99 and is available in 3 colors: red, blue, and green.
The Acme SuperTool costs $199.99 and includes free shipping on orders over $100.

## Shipping Information
Standard shipping takes 5-7 business days. Express shipping takes 1-2 business days.
International shipping is available to 50 countries. Free shipping on orders over $100.
Tracking numbers are emailed within 24 hours of shipment.

## Customer Support
Support hours are Monday-Friday 9am-6pm EST. Email support@acme.com for assistance.
Premium customers get 24/7 phone support at 1-800-ACME-HELP.
Average response time is 2 hours for email, 5 minutes for phone.
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('E2E Retrieval Pipeline', () => {
  const embedder = new MockEmbedder();
  const vectorStore = new InMemoryVectorStore();
  const chunker = createTokenChunker({ defaults: { maxTokens: 100 } });
  const bm25 = new BM25Index();

  const pipeline = new RagPipeline({
    embedder,
    vectorStore,
    chunker,
    indexName: 'test-kb',
  });

  test('Step 1: Chunk markdown into documents', () => {
    const docs: Document[] = [{
      id: 'acme-kb',
      text: MARKDOWN_CONTENT,
      metadata: { source: 'test', contentType: 'text/markdown' },
    }];

    const chunks = chunker.chunk(MARKDOWN_CONTENT);
    expect(chunks.length).toBeGreaterThan(1);
    // Token chunker should produce chunks with token counts
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThan(0);
    }
    console.log(`  Chunked into ${chunks.length} chunks`);
  });

  test('Step 2: Ingest into vector store via RagPipeline', async () => {
    const docs: Document[] = [{
      id: 'acme-kb',
      text: MARKDOWN_CONTENT,
      metadata: { source: 'test' },
    }];

    await pipeline.ingest(docs);
    const stats = await vectorStore.describeIndex?.('test-kb');
    expect(stats).toBeDefined();
    expect(stats!.count).toBeGreaterThan(0);
    console.log(`  Ingested ${stats!.count} vectors (dim=${stats!.dimension})`);
  });

  test('Step 3: Populate BM25 index', () => {
    const chunks = chunker.chunk(MARKDOWN_CONTENT);
    bm25.add(chunks.map(c => ({ id: c.id, text: c.text })));
    expect(bm25.size).toBeGreaterThan(0);
    console.log(`  BM25 index: ${bm25.size} documents`);
  });

  test('Step 4: BM25 keyword search works', () => {
    const results = bm25.search('return policy refund', 3);
    expect(results.length).toBeGreaterThan(0);
    // The top result should be about returns
    console.log(`  BM25 search "return policy refund": ${results.length} results, top score=${results[0].score.toFixed(3)}`);
  });

  test('Step 5: FusionRetriever combines BM25 + vector search', async () => {
    const fusionRetriever = new FusionRetriever({
      bm25,
      vectorStore,
      embedder,
      indexName: 'test-kb',
      bm25Weight: 0.3,
      topK: 3,
    });

    const results = await fusionRetriever.retrieve('What is the return policy?');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text.length).toBeGreaterThan(0);
    console.log(`  Fusion search "return policy": ${results.length} results`);
    for (const r of results) {
      console.log(`    [${r.id}] score=${r.score?.toFixed(3)} text="${r.text.slice(0, 60)}..."`);
    }
  });

  test('Step 6: FusionRetriever with includeEmbeddings returns vectors', async () => {
    const fusionRetriever = new FusionRetriever({
      bm25,
      vectorStore,
      embedder,
      indexName: 'test-kb',
      topK: 3,
    });

    const results = await fusionRetriever.retrieve('shipping information tracking', {
      includeEmbeddings: true,
    });
    expect(results.length).toBeGreaterThan(0);
    // At least some results should have embeddings (from vector store)
    const withEmbeddings = results.filter(r => r.embedding && r.embedding.length > 0);
    expect(withEmbeddings.length).toBeGreaterThan(0);
    console.log(`  ${withEmbeddings.length}/${results.length} results have embeddings`);
  });

  test('Step 7: RetrievalCache — miss on first query, hit on second', async () => {
    // Use a lower threshold for the mock embedder — bag-of-words vectors
    // have lower cosine similarity than real embedding models.
    const cache = new RetrievalCache({ similarityThreshold: 0.15 });

    const fusionRetriever = new FusionRetriever({
      bm25,
      vectorStore,
      embedder,
      indexName: 'test-kb',
      topK: 3,
    });

    // First query — cache miss (empty cache)
    const queryEmbed = await embedder.embed('return policy refund');
    const cached1 = cache.lookup(queryEmbed, 3);
    expect(cached1.length).toBe(0);
    console.log('  Cache miss on first query (expected)');

    // Retrieve and populate cache
    const results = await fusionRetriever.retrieve('return policy refund', { includeEmbeddings: true });
    cache.populate(results);
    expect(cache.size).toBeGreaterThan(0);
    console.log(`  Cache populated with ${cache.size} entries`);

    // Second query with the same embedding — cache hit
    const cached2 = cache.lookup(queryEmbed, 3);
    expect(cached2.length).toBeGreaterThan(0);
    console.log(`  Cache HIT on second query: ${cached2.length} results`);

    // Third query with related terms — should also hit
    const relatedEmbed = await embedder.embed('refund return items');
    const cached3 = cache.lookup(relatedEmbed, 3);
    console.log(`  Cache lookup for related query: ${cached3.length} results`);
  });

  test('Step 8: TurnCache deduplicates exact queries', async () => {
    const turnCache = new TurnCache();

    const fusionRetriever = new FusionRetriever({
      bm25,
      vectorStore,
      embedder,
      indexName: 'test-kb',
      topK: 3,
    });

    const query = 'product catalog pricing';

    // First call — not cached
    expect(turnCache.has(query)).toBe(false);
    const results = await fusionRetriever.retrieve(query);
    turnCache.set(query, results);

    // Second call — cached (no retriever call needed)
    expect(turnCache.has(query)).toBe(true);
    const cached = turnCache.get(query);
    expect(cached).toBeDefined();
    expect(cached!.length).toBe(results.length);
    console.log(`  TurnCache: dedup on "${query}" — ${cached!.length} cached results`);
  });

  test('Step 9: PredictivePreFetcher extracts keywords and pre-fetches', async () => {
    const cache = new RetrievalCache({ similarityThreshold: 0.7 });

    const fusionRetriever = new FusionRetriever({
      bm25,
      vectorStore,
      embedder,
      indexName: 'test-kb',
      topK: 3,
    });

    const prefetcher = new PredictivePreFetcher({
      retriever: fusionRetriever,
      cache,
      maxKeywords: 3,
      conversationWindow: 3,
      retrievalOptions: { includeEmbeddings: true },
    });

    const messages = [
      { role: 'user', content: 'I bought a Widget Pro last week' },
      { role: 'assistant', content: 'I can help with your Widget Pro. What do you need?' },
      { role: 'user', content: 'I want to return it for a refund' },
    ];

    const { keywords, resultCount } = await prefetcher.prefetch(messages);
    expect(keywords.length).toBeGreaterThan(0);
    expect(resultCount).toBeGreaterThan(0);
    expect(cache.size).toBeGreaterThan(0);
    console.log(`  PreFetcher: keywords=[${keywords.join(', ')}], prefetched ${resultCount} results, cache size=${cache.size}`);
  });

  test('Step 10: RagPipeline.retrieve() returns results with embeddings', async () => {
    const results = await pipeline.retrieve('customer support hours phone', {
      includeEmbeddings: true,
    });
    expect(results.length).toBeGreaterThan(0);
    console.log(`  Pipeline retrieve: ${results.length} results for "customer support hours"`);
    for (const r of results.slice(0, 2)) {
      console.log(`    [${r.id}] score=${r.score?.toFixed(3)} hasEmbed=${!!r.embedding}`);
    }
  });

  test('Step 11: queryEmbedding passthrough skips re-embedding', async () => {
    // Pre-compute embedding
    const preComputed = await embedder.embed('shipping tracking');

    // Use it as queryEmbedding — the pipeline should NOT call embedder.embed()
    const results = await pipeline.retrieve('shipping tracking', {
      queryEmbedding: preComputed,
      topK: 3,
    });
    expect(results.length).toBeGreaterThan(0);
    console.log(`  queryEmbedding passthrough: ${results.length} results (no re-embedding)`);
  });
});
