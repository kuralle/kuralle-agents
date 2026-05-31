/**
 * Latency Benchmark — measures every stage of the retrieval pipeline.
 *
 * Usage: bun run scripts/bench.ts
 *
 * Measures:
 *   1. Query embedding (RETRIEVAL_QUERY)
 *   2. BM25 keyword search
 *   3. Vector search (LanceDB)
 *   4. FusionRetriever (BM25 + vector + normalization)
 *   5. CohereReranker
 *   6. Multi-hop decomposition (Gemini Flash)
 *   7. MultiHopRetriever (full: decompose + parallel retrieval + merge)
 *   8. RetrievalQualityChecker assess (arithmetic)
 *   9. RetrievalQualityChecker check + reformulation
 *  10. RetrievalCache lookup (hit)
 *  11. RetrievalCache lookup (miss)
 *  12. Full KnowledgeProvider.retrieve() (cache miss path)
 *  13. Full KnowledgeProvider.retrieve() (cache hit path)
 *  14. Compiled knowledge injection (Layer 1)
 *
 * Prerequisites: Run `bun run ingest` first.
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { google } from '@ai-sdk/google';
import { generateObject } from 'ai';
import { z } from 'zod';
import {
  AiSdkEmbedder,
  BM25Index,
  FusionRetriever,
  CohereReranker,
  MultiHopRetriever,
  RetrievalCache,
  RetrievalQualityChecker,
  createTokenChunker,
  type RetrievalResult,
} from '@kuralle-agents/rag';
import { LanceDBVectorStore } from '@kuralle-agents/lancedb-store';

const currentDir = dirname(fileURLToPath(import.meta.url));
const projectDir = join(currentDir, '..');
const dataDir = join(projectDir, 'data');

// ── Setup ──────────────────────────────────────────────────────────────────

const queryEmbedder = new AiSdkEmbedder({
  model: google.embedding('gemini-embedding-001'),
  providerOptions: { google: { taskType: 'RETRIEVAL_QUERY' } },
});

const vectorStore = new LanceDBVectorStore({ uri: join(dataDir, 'lancedb') });
const bm25 = new BM25Index();

const bm25Path = join(dataDir, 'bm25-docs.json');
if (!existsSync(bm25Path)) {
  console.error('Run `bun run ingest` first.');
  process.exit(1);
}
bm25.add(JSON.parse(readFileSync(bm25Path, 'utf-8')));

const hasCohere = !!process.env.COHERE_API_KEY;
const reranker = hasCohere ? new CohereReranker({ topK: 5 }) : undefined;
const decomposerModel = google('gemini-2.0-flash');

const fusionRetriever = new FusionRetriever({
  bm25,
  vectorStore,
  embedder: queryEmbedder,
  indexName: 'acme-kb',
  bm25Weight: 0.3,
  topK: 10,
  reranker,
});

const multiHopRetriever = new MultiHopRetriever({
  retriever: fusionRetriever,
  decompose: async (query: string) => {
    const { object } = await generateObject({
      model: decomposerModel,
      schema: z.object({ queries: z.array(z.string()).min(1).max(3) }),
      system: 'Decompose into 1-3 independent search queries for a customer support KB. Single-topic → 1 query.',
      prompt: query,
    });
    return object.queries;
  },
  maxSubQueries: 3,
  subQueryTopK: 5,
  topK: 5,
});

const qualityChecker = new RetrievalQualityChecker({
  highThreshold: 0.5,
  mediumThreshold: 0.3,
  reformulate: async (query, results) => {
    const { object } = await generateObject({
      model: decomposerModel,
      schema: z.object({ reformulatedQuery: z.string() }),
      system: 'Reformulate this search query to better match an Acme Corp knowledge base.',
      prompt: `Original: "${query}"\nWeak results:\n${results.map(r => `- ${r.text.slice(0, 80)}`).join('\n')}`,
    });
    return object.reformulatedQuery;
  },
});

// ── Helpers ─────────────────────────────────────────────────────────────────

type BenchResult = { name: string; ms: number; detail?: string };
const results: BenchResult[] = [];

async function bench<T>(name: string, fn: () => Promise<T> | T, detail?: (r: T) => string): Promise<T> {
  const start = performance.now();
  const result = await fn();
  const ms = performance.now() - start;
  const d = detail ? detail(result) : undefined;
  results.push({ name, ms, detail: d });
  return result;
}

// ── Queries ─────────────────────────────────────────────────────────────────

const SINGLE_HOP = 'What is the refund policy?';
const MULTI_HOP = 'Can I return the Widget X100, and if so, how long will the refund take?';
const OFF_TOPIC = 'How to train a neural network with PyTorch?';

// ── Benchmarks ──────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Kuralle Retrieval Pipeline — Latency Benchmark            ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  console.log(`BM25: ${bm25.size} docs | LanceDB: acme-kb | Reranker: ${hasCohere ? 'Cohere v3.5' : 'none'}\n`);

  // ── 1. Query Embedding ─────────────────────────────────────────────────

  const embedding = await bench(
    '1. Query embedding (Gemini, RETRIEVAL_QUERY)',
    () => queryEmbedder.embed(SINGLE_HOP),
    (e) => `dim=${e.length}`,
  );

  // Warm call (Gemini may have connection overhead on first call)
  await bench(
    '1b. Query embedding (warm)',
    () => queryEmbedder.embed(MULTI_HOP),
  );

  // ── 2. BM25 Search ────────────────────────────────────────────────────

  await bench(
    '2. BM25 keyword search',
    () => bm25.search('refund policy return', 5),
    (r) => `${r.length} results`,
  );

  // ── 3. Vector Search (LanceDB) ────────────────────────────────────────

  await bench(
    '3. Vector search (LanceDB)',
    async () => vectorStore.query('acme-kb', {
      queryVector: Array.from(embedding),
      topK: 5,
      includeDocuments: true,
    }),
    (r) => `${r.length} results`,
  );

  // ── 4. FusionRetriever (BM25 + Vector + optional rerank) ──────────────

  const fusionResults = await bench(
    '4. FusionRetriever (BM25+vector' + (hasCohere ? '+Cohere' : '') + ')',
    () => fusionRetriever.retrieve(SINGLE_HOP, { includeEmbeddings: true }),
    (r) => `${r.length} results, top=${r[0]?.score?.toFixed(3)}`,
  );

  // ── 5. Cohere Reranker (standalone) ───────────────────────────────────

  if (reranker) {
    // Get raw fusion results without reranker for standalone test
    const rawFusion = new FusionRetriever({
      bm25, vectorStore, embedder: queryEmbedder,
      indexName: 'acme-kb', bm25Weight: 0.3, topK: 10,
    });
    const raw = await rawFusion.retrieve(SINGLE_HOP);
    await bench(
      '5. CohereReranker (standalone, 10→5)',
      () => reranker.rerank(SINGLE_HOP, raw, { topK: 5 }),
      (r) => `${r.length} results, top=${r[0]?.score?.toFixed(3)}`,
    );
  } else {
    results.push({ name: '5. CohereReranker', ms: 0, detail: 'skipped (no COHERE_API_KEY)' });
  }

  // ── 6. Multi-hop Decomposition (Gemini Flash) ─────────────────────────

  await bench(
    '6. Multi-hop decomposition (Gemini Flash)',
    async () => {
      const { object } = await generateObject({
        model: decomposerModel,
        schema: z.object({ queries: z.array(z.string()).min(1).max(3) }),
        system: 'Decompose into 1-3 independent search queries. Single-topic → 1 query.',
        prompt: MULTI_HOP,
      });
      return object.queries;
    },
    (q) => `${q.length} sub-queries: ${JSON.stringify(q)}`,
  );

  // ── 7. MultiHopRetriever (full pipeline) ──────────────────────────────

  await bench(
    '7. MultiHopRetriever (decompose+retrieve+merge)',
    () => multiHopRetriever.retrieve(MULTI_HOP),
    (r) => `${r.length} results, top=${r[0]?.score?.toFixed(3)}`,
  );

  // Single-hop bypass
  await bench(
    '7b. MultiHopRetriever (single-topic bypass)',
    () => multiHopRetriever.retrieve(SINGLE_HOP),
    (r) => `${r.length} results`,
  );

  // ── 8. Quality Check — assess (arithmetic only) ───────────────────────

  await bench(
    '8. QualityChecker.assess (arithmetic)',
    () => qualityChecker.assess(fusionResults),
    (a) => `${a.quality}, top=${a.topScore.toFixed(3)}, coverage=${(a.coverageEstimate * 100).toFixed(0)}%`,
  );

  // ── 9. Quality Check + reformulation ──────────────────────────────────

  const offTopicResults: RetrievalResult[] = [
    { id: '1', text: 'unrelated content about something else', score: 0.05 },
  ];

  await bench(
    '9. QualityChecker.check + reformulation (Gemini Flash)',
    () => qualityChecker.check('neural network training', offTopicResults, false),
    (r) => `${r.quality}, reformulated=${r.reformulated}, query="${r.reformulatedQuery?.slice(0, 60)}"`,
  );

  // Voice path (no blocking reformulation)
  await bench(
    '9b. QualityChecker.check (voice, background signal)',
    () => qualityChecker.check('neural network training', offTopicResults, true),
    (r) => `${r.quality}, background=${r.backgroundReformulation}`,
  );

  // ── 10. Retrieval Cache ───────────────────────────────────────────────

  const cache = new RetrievalCache({ similarityThreshold: 0.80 });

  // Miss
  await bench(
    '10. RetrievalCache lookup (miss)',
    () => cache.lookup(Array.from(embedding), 5),
    (r) => `${r.length} results`,
  );

  // Populate
  cache.populate(fusionResults, Array.from(embedding));

  // Hit
  await bench(
    '10b. RetrievalCache lookup (hit)',
    () => cache.lookup(Array.from(embedding), 5),
    (r) => `${r.length} results`,
  );

  // Similar query cache hit
  const similarEmbed = await queryEmbedder.embed('How do refunds work?');
  await bench(
    '10c. RetrievalCache lookup (similar query)',
    () => cache.lookup(Array.from(similarEmbed), 5),
    (r) => `${r.length} results (${r.length > 0 ? 'HIT' : 'MISS'})`,
  );

  // ── 11. Compiled Knowledge (Layer 1) ──────────────────────────────────

  const compiledPath = join(dataDir, 'compiled-knowledge.md');
  await bench(
    '11. Compiled knowledge read (Layer 1)',
    () => {
      const text = readFileSync(compiledPath, 'utf-8');
      return text;
    },
    (t) => `${t.length} chars`,
  );

  // ── Print Results ─────────────────────────────────────────────────────

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('══════════════════════════════════════════════════════════════════\n');

  const maxName = Math.max(...results.map(r => r.name.length));

  for (const r of results) {
    const bar = '█'.repeat(Math.min(Math.round(r.ms / 50), 40));
    const msStr = r.ms < 1 ? `${(r.ms * 1000).toFixed(0)}µs` : `${r.ms.toFixed(0)}ms`;
    const pad = ' '.repeat(maxName - r.name.length);
    console.log(`  ${r.name}${pad}  ${msStr.padStart(8)}  ${bar}`);
    if (r.detail) {
      console.log(`  ${' '.repeat(maxName)}  ${' '.repeat(8)}  → ${r.detail}`);
    }
  }

  // ── Summary table ─────────────────────────────────────────────────────

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  LATENCY BUDGET ANALYSIS');
  console.log('══════════════════════════════════════════════════════════════════\n');

  const get = (prefix: string) => results.find(r => r.name.startsWith(prefix))?.ms ?? 0;

  const embedMs = get('1b');
  const bm25Ms = get('2.');
  const vectorMs = get('3.');
  const fusionMs = get('4.');
  const cohereMs = get('5.');
  const decomposeMs = get('6.');
  const multiHopMs = get('7. Multi');
  const assessMs = get('8.');
  const reformMs = get('9. Quality');
  const cacheHitMs = get('10b');
  const cacheMissMs = get('10. Retr');
  const compiledMs = get('11.');

  console.log('  TEXT AGENT (1-3s budget):');
  console.log(`    Single-hop:     embed(${embedMs.toFixed(0)}ms) + fusion(${fusionMs.toFixed(0)}ms) = ${(embedMs + fusionMs).toFixed(0)}ms`);
  console.log(`    Multi-hop:      decompose(${decomposeMs.toFixed(0)}ms) + retrieval(${(multiHopMs - decomposeMs).toFixed(0)}ms) = ${multiHopMs.toFixed(0)}ms`);
  console.log(`    Reformulation:  assess(${assessMs.toFixed(3)}ms) + reformulate(${reformMs.toFixed(0)}ms) = ${(assessMs + reformMs).toFixed(0)}ms`);
  console.log(`    Worst case:     ${(multiHopMs + reformMs).toFixed(0)}ms — ${multiHopMs + reformMs < 3000 ? '✓ within budget' : '✗ EXCEEDS budget'}`);
  console.log();
  console.log('  VOICE AGENT (0ms budget):');
  console.log(`    Cache hit:      ${cacheHitMs < 1 ? `${(cacheHitMs * 1000).toFixed(0)}µs` : `${cacheHitMs.toFixed(1)}ms`} — ${cacheHitMs < 1 ? '✓ sub-millisecond' : '⚠ above target'}`);
  console.log(`    Cache miss:     ${cacheMissMs < 1 ? `${(cacheMissMs * 1000).toFixed(0)}µs` : `${cacheMissMs.toFixed(1)}ms`} — returns empty, background fetch`);
  console.log(`    Compiled:       ${compiledMs < 1 ? `${(compiledMs * 1000).toFixed(0)}µs` : `${compiledMs.toFixed(1)}ms`} — always available`);
  console.log(`    Assess only:    ${assessMs < 1 ? `${(assessMs * 1000).toFixed(0)}µs` : `${assessMs.toFixed(3)}ms`} — pure arithmetic`);
  console.log();

  // ── Component breakdown ────────────────────────────────────────────────

  console.log('  COMPONENT BREAKDOWN:');
  console.log(`    Gemini Embedding API:     ${embedMs.toFixed(0)}ms`);
  console.log(`    BM25 search:              ${bm25Ms < 1 ? `${(bm25Ms * 1000).toFixed(0)}µs` : `${bm25Ms.toFixed(0)}ms`}`);
  console.log(`    LanceDB vector search:    ${vectorMs.toFixed(0)}ms`);
  console.log(`    Cohere rerank:            ${cohereMs > 0 ? `${cohereMs.toFixed(0)}ms` : 'N/A'}`);
  console.log(`    Gemini Flash decompose:   ${decomposeMs.toFixed(0)}ms`);
  console.log(`    Gemini Flash reformulate: ${reformMs.toFixed(0)}ms`);
  console.log(`    Quality assess:           ${assessMs < 1 ? `${(assessMs * 1000).toFixed(0)}µs` : `${assessMs.toFixed(3)}ms`}`);
  console.log(`    Cache lookup (hit):       ${cacheHitMs < 1 ? `${(cacheHitMs * 1000).toFixed(0)}µs` : `${cacheHitMs.toFixed(1)}ms`}`);
  console.log(`    Cache lookup (miss):      ${cacheMissMs < 1 ? `${(cacheMissMs * 1000).toFixed(0)}µs` : `${cacheMissMs.toFixed(1)}ms`}`);
  console.log(`    Compiled knowledge:       ${compiledMs < 1 ? `${(compiledMs * 1000).toFixed(0)}µs` : `${compiledMs.toFixed(1)}ms`}`);
  console.log();
}

main().catch(console.error);
