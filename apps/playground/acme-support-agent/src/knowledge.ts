/**
 * Knowledge pipeline — three-layer retrieval with quality checks.
 *
 * Three-layer retrieval:
 *   Layer 1: Compiled knowledge (0ms, system prompt injection)
 *   Layer 2: Semantic cache with RETRIEVAL_QUERY embeddings (~0.4ms)
 *   Layer 3: MultiHopRetriever → FusionRetriever → CohereReranker → QualityChecker
 *
 * Features:
 *   - MultiHopRetriever (cross-document decomposition)
 *   - Task-type-aware embeddings (RETRIEVAL_QUERY for queries)
 *   - RetrievalQualityChecker (CRAG three-bucket + reformulation)
 *   - qualityCheck config on KnowledgeProviderConfig
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
  type Retriever,
  type RetrievalResult,
} from '@kuralle-agents/rag';
import type { HarnessConfig } from '@kuralle-agents/core';
import { LanceDBVectorStore } from '@kuralle-agents/lancedb-store';

type KnowledgeProviderConfig = NonNullable<HarnessConfig['knowledge']>;

const currentDir = dirname(fileURLToPath(import.meta.url));
const dataDir = join(currentDir, '..', 'data');

// ─── Embedder: RETRIEVAL_QUERY task type (query-time) ────────────────────────

export const queryEmbedder = new AiSdkEmbedder({
  model: google.embedding('gemini-embedding-001'),
  providerOptions: { google: { taskType: 'RETRIEVAL_QUERY' } },
});

// ─── Vector Store: LanceDB (persistent) ──────────────────────────────────────

export const vectorStore = new LanceDBVectorStore({ uri: join(dataDir, 'lancedb') });

// ─── BM25 Index (loaded from ingestion output) ──────────────────────────────

export const bm25 = new BM25Index();

const bm25Path = join(dataDir, 'bm25-docs.json');
if (existsSync(bm25Path)) {
  const docs = JSON.parse(readFileSync(bm25Path, 'utf-8'));
  bm25.add(docs);
  console.log(`[knowledge] BM25: ${bm25.size} documents`);
} else {
  console.warn('[knowledge] No BM25 data — run `bun run ingest` first');
}

// ─── Cohere Reranker (optional, needs COHERE_API_KEY) ────────────────────────

const reranker = process.env.COHERE_API_KEY
  ? new CohereReranker({ topK: 5 })
  : undefined;

console.log(`[knowledge] Reranker: ${reranker ? 'Cohere v3.5' : 'disabled (no COHERE_API_KEY)'}`);

// ─── FusionRetriever: BM25 + Vector hybrid search ───────────────────────────

const fusionRetriever = new FusionRetriever({
  bm25,
  vectorStore,
  embedder: queryEmbedder,
  indexName: 'acme-kb',
  bm25Weight: 0.3,
  topK: 10,
  reranker,
});

// ─── MultiHopRetriever ──────────────────────────────────────────────────────
//
// Decomposes multi-topic queries into sub-queries, retrieves in parallel,
// merges results. Uses Gemini Flash for fast decomposition.

const decomposer = google('gemini-2.0-flash');

const multiHopRetriever: Retriever = new MultiHopRetriever({
  retriever: fusionRetriever,
  decompose: async (query: string): Promise<string[]> => {
    try {
      const { object } = await generateObject({
        model: decomposer,
        schema: z.object({
          queries: z.array(z.string()).min(1).max(3).describe(
            'Independent search queries. Return 1 query if the question is about a single topic. ' +
            'Return 2-3 queries if the question spans multiple topics (e.g., a product AND a policy).',
          ),
        }),
        system: 'Decompose the user question into 1-3 independent search queries for a customer support knowledge base. ' +
          'Each query should retrieve a different piece of information. ' +
          'If the question is about a single topic, return just that one query.',
        prompt: query,
      });
      console.log(`  [decompose] "${query}" → ${object.queries.length} sub-queries: ${JSON.stringify(object.queries)}`);
      return object.queries;
    } catch {
      return [query]; // Fallback to single-hop
    }
  },
  maxSubQueries: 3,
  subQueryTopK: 5,
  topK: 5,
});

console.log(`[knowledge] MultiHopRetriever: enabled (Gemini Flash decomposition)`);

// ─── Compiled Knowledge (Layer 1) ───────────────────────────────────────────

const compiledPath = join(dataDir, 'compiled-knowledge.md');
const compiledKnowledge = existsSync(compiledPath)
  ? readFileSync(compiledPath, 'utf-8')
  : undefined;

if (compiledKnowledge) {
  console.log(`[knowledge] Compiled knowledge: ${compiledKnowledge.length} chars`);
}

// ─── Quality Check Reformulator ─────────────────────────────────────────────
//
// When retrieval quality is low, reformulates the query using Gemini Flash.
// Text agents: runs inline. Voice agents: background signal only.

async function reformulate(query: string, results: RetrievalResult[]): Promise<string> {
  const { object } = await generateObject({
    model: decomposer,
    schema: z.object({
      reformulatedQuery: z.string().describe('A clearer, more specific search query'),
    }),
    system: 'The original search query returned low-quality results from an Acme Corp knowledge base. ' +
      'Reformulate it to be more specific and likely to match relevant documents. ' +
      'The knowledge base contains: product info (Pro, Enterprise, Starter, Widget X100, Cloud Backup), ' +
      'policies (refund, shipping, warranty, privacy, billing, EU refund, account).',
    prompt: `Original query: "${query}"\n\nLow-quality results:\n${results.map(r => `- ${r.text.slice(0, 100)}`).join('\n')}`,
  });
  console.log(`  [reformulate] "${query}" → "${object.reformulatedQuery}"`);
  return object.reformulatedQuery;
}

// ─── KnowledgeProviderConfig ────────────────────────────────────────────────
//
// Passed to createRuntime({ knowledge: knowledgeConfig }).
// The Runtime builds a KnowledgeProvider from this config.

export const knowledgeConfig: KnowledgeProviderConfig = {
  retriever: multiHopRetriever,
  embedder: queryEmbedder,
  compiled: compiledKnowledge,

  cache: {
    maxEntries: 128,
    ttlMs: 300_000,           // 5 minutes
    similarityThreshold: 0.80,
  },

  prefetch: {
    enabled: true,
    maxKeywords: 3,
    conversationWindow: 5,
  },

  defaults: {
    topK: 5,
    maxOutputTokens: 2000,
    includeEmbeddings: true,
  },

  // Quality checking with CRAG three-bucket pattern
  qualityCheck: {
    highThreshold: 0.5,    // Calibrated for Cohere reranker scores
    mediumThreshold: 0.3,
    reformulate,
  },
};

console.log(`[knowledge] Quality check: enabled (high≥0.5, medium≥0.3, reformulation on low)`);
console.log(`[knowledge] Pipeline ready: MultiHop → Fusion(BM25+Vector) → ${reranker ? 'Cohere → ' : ''}QualityCheck → Cache`);
