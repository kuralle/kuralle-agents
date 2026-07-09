/**
 * RetrievalCache — In-memory semantic cache for retrieval results.
 *
 * Dual-index design:
 * - **Query index**: Stores the query embedding that produced each result set.
 *   Lookup compares new query embeddings against stored query embeddings
 *   (query-to-query cosine similarity is typically 0.7-0.95 for similar queries).
 *   This works well with asymmetric embedding models (OpenAI, Gemini).
 *
 * - **Document index**: Stores individual document embeddings from results.
 *   Used by PredictivePreFetcher writeback where no query embedding exists.
 *
 * Populated by retrieval writeback and predictive pre-fetch. LRU eviction + TTL.
 *
 * Derived from Salesforce's VoiceAgentRAG paper (arXiv:2603.02206).
 * Pure TypeScript, zero external dependencies.
 */

import type { RetrievalResult } from '../types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RetrievalCacheConfig {
  /** Maximum number of query entries in the cache. Default: 256. */
  maxEntries?: number;
  /** Cache entry TTL in milliseconds. Default: 300000 (5 minutes). */
  ttlMs?: number;
  /** Minimum cosine similarity for a cache hit. Default: 0.85. */
  similarityThreshold?: number;
}

// ---------------------------------------------------------------------------
// Cache entries
// ---------------------------------------------------------------------------

/** A cached query → results mapping. */
interface QueryCacheEntry {
  queryEmbedding: readonly number[];
  results: RetrievalResult[];
  insertedAt: number;
  lastAccessedAt: number;
}

/** A cached document embedding for document-index lookups. */
interface DocCacheEntry {
  result: RetrievalResult;
  embedding: readonly number[];
  insertedAt: number;
  lastAccessedAt: number;
}

// ---------------------------------------------------------------------------
// RetrievalCache
// ---------------------------------------------------------------------------

export class RetrievalCache {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly similarityThreshold: number;

  /** Query-indexed cache: query embedding → result set. */
  private queryEntries: QueryCacheEntry[] = [];
  /** Document-indexed cache: individual document embeddings. */
  private docEntries: DocCacheEntry[] = [];

  constructor(config?: RetrievalCacheConfig) {
    this.maxEntries = config?.maxEntries ?? 256;
    this.ttlMs = config?.ttlMs ?? 300_000;
    this.similarityThreshold = config?.similarityThreshold ?? 0.85;
  }

  /** Total number of cached items (query entries + doc entries). */
  get size(): number {
    return this.queryEntries.length + this.docEntries.length;
  }

  /**
   * Look up cached results by query embedding similarity.
   *
   * First checks the query index (query-to-query similarity, high accuracy
   * with asymmetric models). Falls back to the document index if no
   * query-level match is found.
   *
   * @param queryEmbedding - The query's embedding vector.
   * @param topK - Maximum number of results to return. Default: 5.
   * @returns Matching cached results, or empty array on cache miss.
   */
  lookup(queryEmbedding: readonly number[], topK = 5): RetrievalResult[] {
    const now = Date.now();

    // 1. Check query index first (query-to-query similarity is high)
    let bestMatch: QueryCacheEntry | undefined;
    let bestSimilarity = 0;

    for (const entry of this.queryEntries) {
      if (now - entry.insertedAt > this.ttlMs) continue;

      const similarity = cosineSimilarity(queryEmbedding, entry.queryEmbedding);
      if (similarity >= this.similarityThreshold && similarity > bestSimilarity) {
        bestMatch = entry;
        bestSimilarity = similarity;
      }
    }

    if (bestMatch) {
      bestMatch.lastAccessedAt = Date.now();
      // Preserve original retriever scores — do not overwrite with cache similarity
      return bestMatch.results.slice(0, topK);
    }

    // 2. Fall back to document index (for pre-fetched content)
    const hits: Array<{ entry: DocCacheEntry; similarity: number }> = [];

    for (const entry of this.docEntries) {
      if (now - entry.insertedAt > this.ttlMs) continue;

      const similarity = cosineSimilarity(queryEmbedding, entry.embedding);
      if (similarity >= this.similarityThreshold) {
        hits.push({ entry, similarity });
      }
    }

    if (hits.length === 0) return [];

    hits.sort((a, b) => b.similarity - a.similarity);

    const now2 = Date.now();
    for (const hit of hits.slice(0, topK)) {
      hit.entry.lastAccessedAt = now2;
    }

    return hits.slice(0, topK).map(h => ({
      ...h.entry.result,
      score: h.similarity,
    }));
  }

  /**
   * Populate the cache with retrieval results and the query embedding
   * that produced them.
   *
   * When `queryEmbedding` is provided, stores a query-indexed entry
   * (preferred for lookup — query-to-query similarity is high).
   *
   * Also stores individual document embeddings in the document index
   * for results that have them.
   */
  populate(results: RetrievalResult[], queryEmbedding?: readonly number[]): void {
    const now = Date.now();

    // Store query-indexed entry when query embedding is available
    if (queryEmbedding && queryEmbedding.length > 0 && results.length > 0) {
      this.queryEntries.push({
        queryEmbedding,
        results: [...results],
        insertedAt: now,
        lastAccessedAt: now,
      });
    }

    // Store document-indexed entries for results with embeddings
    for (const result of results) {
      if (!result.embedding || result.embedding.length === 0) continue;

      // Dedup by result ID
      const existingIdx = this.docEntries.findIndex(e => e.result.id === result.id);
      if (existingIdx >= 0) {
        this.docEntries.splice(existingIdx, 1);
      }

      this.docEntries.push({
        result,
        embedding: result.embedding,
        insertedAt: now,
        lastAccessedAt: now,
      });
    }

    this.evict();
  }

  private evict(): void {
    const now = Date.now();

    // Evict expired query entries
    this.queryEntries = this.queryEntries.filter(
      e => now - e.insertedAt <= this.ttlMs,
    );

    // Evict expired doc entries
    this.docEntries = this.docEntries.filter(
      e => now - e.insertedAt <= this.ttlMs,
    );

    // LRU eviction on query entries
    if (this.queryEntries.length > this.maxEntries) {
      this.queryEntries.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
      this.queryEntries = this.queryEntries.slice(this.queryEntries.length - this.maxEntries);
    }

    // LRU eviction on doc entries
    if (this.docEntries.length > this.maxEntries) {
      this.docEntries.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
      this.docEntries = this.docEntries.slice(this.docEntries.length - this.maxEntries);
    }
  }

  /** Remove all entries from the cache. */
  clear(): void {
    this.queryEntries = [];
    this.docEntries = [];
  }
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    magnitudeA += a[i] * a[i];
    magnitudeB += b[i] * b[i];
  }

  const magA = Math.sqrt(magnitudeA);
  const magB = Math.sqrt(magnitudeB);

  if (magA === 0 || magB === 0) return 0;

  return dotProduct / (magA * magB);
}
