/**
 * Retrieval Quality Benchmark — compares always-decompose vs quality-gated.
 *
 * For each query, runs BOTH strategies and compares:
 *   - Which documents were retrieved
 *   - Relevance scores
 *   - Cross-document coverage (did it find info from multiple sources?)
 *   - Whether the answer could be grounded in the results
 *
 * Usage: bun run scripts/bench-quality.ts
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
  type RetrievalResult,
} from '@kuralle-agents/rag';
import { LanceDBVectorStore } from '@kuralle-agents/lancedb-store';

const currentDir = dirname(fileURLToPath(import.meta.url));
const projectDir = join(currentDir, '..');
const dataDir = join(projectDir, 'data');

// ── Setup ───────────────────────────────────────────────────────────────────

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
const cohereReranker = hasCohere ? new CohereReranker({ topK: 5 }) : undefined;
const decomposerModel = google('gemini-2.0-flash');

// Two fusion retrievers: with and without reranker
const fusionWithReranker = new FusionRetriever({
  bm25, vectorStore, embedder: queryEmbedder,
  indexName: 'acme-kb', bm25Weight: 0.3, topK: 10, reranker: cohereReranker,
});

const fusionWithoutReranker = new FusionRetriever({
  bm25, vectorStore, embedder: queryEmbedder,
  indexName: 'acme-kb', bm25Weight: 0.3, topK: 10,
});

const decompose = async (query: string) => {
  const { object } = await generateObject({
    model: decomposerModel,
    schema: z.object({ queries: z.array(z.string()).min(1).max(3) }),
    system: 'Decompose into 1-3 independent search queries for a customer support KB. Single-topic → 1 query.',
    prompt: query,
  });
  return object.queries;
};

// ── Test Queries with Expected Coverage ─────────────────────────────────────

interface TestQuery {
  label: string;
  query: string;
  /** Keywords that MUST appear in the combined results for full coverage. */
  requiredCoverage: string[];
  /** Category: single-topic or cross-document */
  type: 'single' | 'cross-document';
}

const queries: TestQuery[] = [
  {
    label: 'Single-hop: refund policy',
    query: 'What is the refund policy?',
    requiredCoverage: ['refund', '30 days'],
    type: 'single',
  },
  {
    label: 'Single-hop: shipping costs',
    query: 'How much does shipping cost?',
    requiredCoverage: ['shipping', '$12.99'],
    type: 'single',
  },
  {
    label: 'Single-hop: Widget X100 specs',
    query: 'What is the Acme Widget X100?',
    requiredCoverage: ['widget x100', '$149.99', 'touchscreen'],
    type: 'single',
  },
  {
    label: 'Cross-doc: Widget return + refund time',
    query: 'Can I return the Widget X100, and if so, how long will the refund take?',
    requiredCoverage: ['widget x100', 'refund', '30 days'],
    type: 'cross-document',
  },
  {
    label: 'Cross-doc: Pro Plan + Cloud Backup',
    query: 'Does the Pro Plan include cloud backup, and what does it cost?',
    requiredCoverage: ['pro', '$29', 'backup', '$4.99'],
    type: 'cross-document',
  },
  {
    label: 'Cross-doc: EU refund + shipping',
    query: 'I am in the EU, can I return something and who pays for shipping?',
    requiredCoverage: ['eu', '14-day', 'shipping'],
    type: 'cross-document',
  },
  {
    label: 'Cross-doc: warranty + Widget X100',
    query: 'What warranty does the Widget X100 come with, and can I extend it?',
    requiredCoverage: ['warranty', '1-year', 'extended', 'widget x100'],
    type: 'cross-document',
  },
  {
    label: 'Off-topic: no KB match',
    query: 'How do I train a neural network with PyTorch?',
    requiredCoverage: [],
    type: 'single',
  },
];

// ── Run ─────────────────────────────────────────────────────────────────────

// ── Helpers ─────────────────────────────────────────────────────────────────

function checkCoverage(results: RetrievalResult[], required: string[]): { covered: string[]; missing: string[] } {
  const allText = results.map(r => r.text).join(' ').toLowerCase();
  const covered: string[] = [];
  const missing: string[] = [];
  for (const keyword of required) {
    if (allText.includes(keyword.toLowerCase())) {
      covered.push(keyword);
    } else {
      missing.push(keyword);
    }
  }
  return { covered, missing };
}

interface ConfigResult {
  topScore: number;
  resultCount: number;
  coverageCount: number;
  coverageTotal: number;
  missing: string[];
  decomposed: boolean;
  ms: number;
}

async function runConfig(
  label: string,
  fusionRetriever: FusionRetriever,
  threshold: number,
  query: string,
  required: string[],
): Promise<ConfigResult> {
  let decomposed = false;
  const retriever = new MultiHopRetriever({
    retriever: fusionRetriever,
    decompose: async (q) => { decomposed = true; return decompose(q); },
    topK: 5,
    qualityThreshold: threshold,
  });

  const start = performance.now();
  const results = await retriever.retrieve(query);
  const ms = performance.now() - start;

  const cov = checkCoverage(results, required);
  return {
    topScore: results[0]?.score ?? 0,
    resultCount: results.length,
    coverageCount: cov.covered.length,
    coverageTotal: required.length,
    missing: cov.missing,
    decomposed,
    ms,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  Retrieval Quality: 4-Way Comparison                               ║');
  console.log('║                                                                     ║');
  console.log('║  A = Always Decompose + Reranker    C = Always Decompose, No Rerank ║');
  console.log('║  B = Quality-Gated + Reranker       D = Quality-Gated, No Rerank    ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

  if (!hasCohere) {
    console.log('⚠ No COHERE_API_KEY — configs A and B will run without reranker.\n');
  }

  const summary: Array<{
    label: string;
    type: string;
    A: ConfigResult;
    B: ConfigResult;
    C: ConfigResult;
    D: ConfigResult;
  }> = [];

  for (const tq of queries) {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  ${tq.label} [${tq.type}]`);
    console.log(`  "${tq.query}"`);
    console.log(`  Expected: [${tq.requiredCoverage.join(', ')}]`);
    console.log(`${'─'.repeat(70)}`);

    // Config A: Always Decompose + Reranker
    const A = await runConfig('A', fusionWithReranker, 0, tq.query, tq.requiredCoverage);
    await new Promise(r => setTimeout(r, 3000));

    // Config B: Quality-Gated + Reranker
    const B = await runConfig('B', fusionWithReranker, 0.5, tq.query, tq.requiredCoverage);
    await new Promise(r => setTimeout(r, 3000));

    // Config C: Always Decompose, No Reranker
    const C = await runConfig('C', fusionWithoutReranker, 0, tq.query, tq.requiredCoverage);
    await new Promise(r => setTimeout(r, 1000));

    // Config D: Quality-Gated, No Reranker
    const D = await runConfig('D', fusionWithoutReranker, 0.5, tq.query, tq.requiredCoverage);

    summary.push({ label: tq.label, type: tq.type, A, B, C, D });

    // Print compact comparison
    const fmt = (c: ConfigResult) =>
      `${c.coverageCount}/${c.coverageTotal} | top=${c.topScore.toFixed(3)} | ${c.ms.toFixed(0).padStart(5)}ms | decomp=${c.decomposed ? 'Y' : 'N'}`;

    console.log(`\n  Config                           Coverage   Top Score    Time    Decomp`);
    console.log(`  A: Always + Reranker             ${fmt(A)}`);
    console.log(`  B: Gated + Reranker              ${fmt(B)}`);
    console.log(`  C: Always, No Reranker           ${fmt(C)}`);
    console.log(`  D: Gated, No Reranker            ${fmt(D)}`);

    // Flag coverage regressions
    if (B.coverageCount < A.coverageCount) {
      console.log(`  ⚠ REGRESSION: Quality-gated missed [${B.missing.join(', ')}] with reranker`);
    }
    if (D.coverageCount < C.coverageCount) {
      console.log(`  ⚠ REGRESSION: Quality-gated missed [${D.missing.join(', ')}] without reranker`);
    }

    await new Promise(r => setTimeout(r, 3000));
  }

  // ── Summary Table ─────────────────────────────────────────────────────

  console.log(`\n${'═'.repeat(70)}`);
  console.log('  SUMMARY TABLE');
  console.log(`${'═'.repeat(70)}\n`);

  const pad = (s: string, n: number) => s.padEnd(n);

  console.log(`  ${pad('Query', 38)}  A    B    C    D    B-vs-A  D-vs-C`);
  console.log(`  ${'─'.repeat(38)}  ${'───  '.repeat(4)}${'──────  '.repeat(2)}`);

  let totalA = 0, totalB = 0, totalC = 0, totalD = 0;
  let regressionsReranker = 0, regressionsNoReranker = 0;

  for (const s of summary) {
    const covA = `${s.A.coverageCount}/${s.A.coverageTotal}`;
    const covB = `${s.B.coverageCount}/${s.B.coverageTotal}`;
    const covC = `${s.C.coverageCount}/${s.C.coverageTotal}`;
    const covD = `${s.D.coverageCount}/${s.D.coverageTotal}`;

    const diffBA = s.B.coverageCount - s.A.coverageCount;
    const diffDC = s.D.coverageCount - s.C.coverageCount;

    const fmtDiff = (d: number) => d > 0 ? `+${d} ✓` : d < 0 ? `${d} ⚠` : '  =';

    console.log(`  ${pad(s.label, 38)}  ${covA.padEnd(4)} ${covB.padEnd(4)} ${covC.padEnd(4)} ${covD.padEnd(4)} ${fmtDiff(diffBA).padEnd(6)}  ${fmtDiff(diffDC)}`);

    totalA += s.A.ms; totalB += s.B.ms; totalC += s.C.ms; totalD += s.D.ms;
    if (diffBA < 0) regressionsReranker++;
    if (diffDC < 0) regressionsNoReranker++;
  }

  console.log();
  console.log(`  Total time:  A=${(totalA/1000).toFixed(1)}s  B=${(totalB/1000).toFixed(1)}s  C=${(totalC/1000).toFixed(1)}s  D=${(totalD/1000).toFixed(1)}s`);
  console.log(`  Speedup:     B vs A = ${((1 - totalB/totalA) * 100).toFixed(0)}%    D vs C = ${((1 - totalD/totalC) * 100).toFixed(0)}%`);
  console.log(`  Regressions: with reranker = ${regressionsReranker}    without reranker = ${regressionsNoReranker}`);
  console.log();
}

main().catch(console.error);
