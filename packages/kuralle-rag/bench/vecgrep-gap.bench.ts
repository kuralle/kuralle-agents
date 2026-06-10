/**
 * vecgrep-gap benchmark — measures the four offline metrics behind the
 * VecGrep-gap sprint, before and after the WP1/WP3/WP4/WP5 changes.
 *
 * Run: bun bench/vecgrep-gap.bench.ts [baseline|after]
 *
 * Phases:
 *   A — ingest cost: embed texts + wall ms for fresh ingest vs unchanged re-ingest
 *   B — wake cost: KnowledgeFs.open() init ms when the keyword tier must be
 *       (re)seeded from the store (simulates a DO hibernation wake)
 *   C — token economy: tokens returned per exact-term query, semantic tier
 *       (topK=10) vs keyword/grep tier (limit=8), plus hit@k correctness
 *   D — silent provider swap: same-dimension embedder swap; overlap@5 vs
 *       ground truth and how many calls errored (baseline: zero = silent)
 */
import { RagPipeline } from '../src/pipeline/RagPipeline.js';
import { createMarkdownChunker } from '../src/chunkers.js';
import { InMemoryVectorStore } from '../src/vectorStores/InMemoryVectorStore.js';
import { BM25Index } from '../src/search/BM25Index.js';
import { KnowledgeFs } from '../src/fs/KnowledgeFs.js';
import { CHUNK_INDEX_META_KEY, PAGE_META_KEY } from '../src/fs/path-tree.js';
import {
  CountingEmbedder,
  HashEmbedder,
  estimateTokens,
  makeCorpus,
  median,
  writeResults,
} from './lib.js';

const mode = (process.argv[2] ?? 'baseline') as 'baseline' | 'after';
const INDEX = 'bench-kb';
const results: Record<string, unknown> = { mode, date: new Date().toISOString() };

const corpus = makeCorpus({ docs: 200, sections: 6, wordsPerSection: 60 });
console.log(`corpus: ${corpus.documents.length} docs`);

// ---------------------------------------------------------------------------
// Phase A — ingest cost (fresh vs unchanged re-ingest)
// ---------------------------------------------------------------------------
async function phaseA() {
  const embedder = new CountingEmbedder(new HashEmbedder({ seed: 'model-a' }));
  const store = new InMemoryVectorStore();
  const pipeline = new RagPipeline({
    embedder,
    vectorStore: store,
    chunker: createMarkdownChunker(),
    indexName: INDEX,
  });

  let t0 = performance.now();
  await pipeline.ingest(corpus.documents);
  const freshMs = performance.now() - t0;
  const freshTexts = embedder.textsEmbedded;

  embedder.reset();
  t0 = performance.now();
  await pipeline.ingest(corpus.documents); // identical corpus — nothing changed
  const reMs = performance.now() - t0;
  const reTexts = embedder.textsEmbedded;

  const stats = await store.describeIndex(INDEX);
  results.phaseA = {
    chunksInStore: stats.count,
    fresh: { textsEmbedded: freshTexts, ms: Math.round(freshMs) },
    unchangedReingest: { textsEmbedded: reTexts, ms: Math.round(reMs) },
  };
  console.log('A ingest:', JSON.stringify(results.phaseA));
  return { store, embedder };
}

// ---------------------------------------------------------------------------
// Phase B — wake cost (KnowledgeFs.open with keyword tier seeding)
// ---------------------------------------------------------------------------
async function phaseB() {
  // KnowledgeFs needs page/chunk_index metadata — build the store directly,
  // mirroring how KB ingestion lays out entries.
  const embedder = new HashEmbedder({ seed: 'model-a' });
  const store = new InMemoryVectorStore();
  await store.createIndex({ indexName: INDEX, dimension: embedder.dimension, metric: 'cosine' });

  const chunker = createMarkdownChunker();
  const entries = [];
  for (const doc of corpus.documents) {
    const chunks = chunker.chunk(doc.text);
    const page = String(doc.metadata?.page);
    const vectors = await embedder.embedMany(chunks.map((c) => c.text));
    for (let i = 0; i < chunks.length; i++) {
      entries.push({
        id: `${page}#${i}`,
        vector: vectors[i]!,
        metadata: { [PAGE_META_KEY]: page, [CHUNK_INDEX_META_KEY]: i },
        document: chunks[i]!.text,
      });
    }
  }
  await store.upsert(INDEX, entries);

  const runs: number[] = [];
  for (let i = 0; i < 7; i++) {
    const t0 = performance.now();
    await KnowledgeFs.open({ store, indexName: INDEX, bm25: new BM25Index() });
    runs.push(performance.now() - t0);
  }

  results.phaseB = {
    chunkEntries: entries.length,
    bm25WakeMsMedian: Number(median(runs).toFixed(2)),
    runsMs: runs.map((r) => Number(r.toFixed(2))),
  };
  console.log('B wake:', JSON.stringify(results.phaseB));
  return { store, entries: entries.length };
}

// ---------------------------------------------------------------------------
// Phase C — token economy per tier (exact-term queries)
// ---------------------------------------------------------------------------
async function phaseC(storeFromB: InMemoryVectorStore) {
  const embedder = new HashEmbedder({ seed: 'model-a' });
  const pipeline = new RagPipeline({
    embedder,
    vectorStore: storeFromB,
    chunker: createMarkdownChunker(),
    indexName: INDEX,
  });
  const kfs = await KnowledgeFs.open({
    store: storeFromB,
    indexName: INDEX,
    bm25: new BM25Index(),
  });

  const sampleDocs = ['doc-007', 'doc-042', 'doc-099', 'doc-150', 'doc-188'];
  let semanticTokens = 0;
  let grepTokens = 0;
  let semanticHits = 0;
  let grepHits = 0;

  for (const docId of sampleDocs) {
    const refCode = corpus.refCodes.get(docId)!;
    const page = `/kb/${docId}.md`;

    const semantic = await pipeline.retrieve(refCode); // default topK=10
    semanticTokens += semantic.reduce((s, r) => s + estimateTokens(r.text), 0);
    if (semantic.some((r) => String(r.id).startsWith(`${page}#`))) semanticHits += 1;

    const grep = await kfs.search(refCode, { limit: 8 });
    grepTokens += grep.reduce((s, h) => s + estimateTokens(h.text), 0);
    if (grep.some((h) => h.slug === page)) grepHits += 1;
  }

  results.phaseC = {
    queries: sampleDocs.length,
    semanticTier: {
      avgTokensPerQuery: Math.round(semanticTokens / sampleDocs.length),
      exactTermHitRate: semanticHits / sampleDocs.length,
    },
    grepTier: {
      avgTokensPerQuery: Math.round(grepTokens / sampleDocs.length),
      exactTermHitRate: grepHits / sampleDocs.length,
    },
  };
  console.log('C tokens:', JSON.stringify(results.phaseC));
}

// ---------------------------------------------------------------------------
// Phase D — silent same-dimension provider swap
// ---------------------------------------------------------------------------
async function phaseD() {
  const modelA = new HashEmbedder({ seed: 'model-a' });
  const modelB = new HashEmbedder({ seed: 'model-b' }); // same dimension!
  const store = new InMemoryVectorStore();

  const ingestPipeline = new RagPipeline({
    embedder: modelA,
    vectorStore: store,
    chunker: createMarkdownChunker(),
    indexName: INDEX,
  });
  await ingestPipeline.ingest(corpus.documents);

  const queries = Array.from({ length: 20 }, (_, i) => {
    const docId = `doc-${String(i * 9).padStart(3, '0')}`;
    return `Section 2 of ${docId} ${corpus.refCodes.get(docId)}`;
  });

  const truthPipeline = ingestPipeline; // same embedder the index was built with
  const swappedPipeline = new RagPipeline({
    embedder: modelB,
    vectorStore: store,
    chunker: createMarkdownChunker(),
    indexName: INDEX,
  });

  let overlapSum = 0;
  let errors = 0;
  for (const q of queries) {
    const truth = (await truthPipeline.retrieve(q, { topK: 5 })).map((r) => r.id);
    try {
      const swapped = (await swappedPipeline.retrieve(q, { topK: 5 })).map((r) => r.id);
      const overlap = truth.filter((id) => swapped.includes(id)).length / 5;
      overlapSum += overlap;
    } catch {
      errors += 1;
    }
  }

  results.phaseD = {
    queries: queries.length,
    avgOverlapAt5VsTruth: Number((overlapSum / (queries.length - errors || 1)).toFixed(3)),
    errorsThrown: errors,
    silentCorruption: errors === 0,
  };
  console.log('D swap:', JSON.stringify(results.phaseD));
}

// ---------------------------------------------------------------------------

await phaseA();
const b = await phaseB();
await phaseC(b.store);
await phaseD();
await writeResults(`vecgrep-gap-${mode}`, results);
