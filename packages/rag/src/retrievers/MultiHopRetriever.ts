/**
 * MultiHopRetriever — Quality-gated multi-hop retrieval.
 *
 * Strategy: try direct retrieval first. If the scores are strong enough,
 * return immediately without paying the decomposition cost. If scores are
 * weak, decompose the query and retrieve again with sub-queries.
 *
 * This is the CRAG pattern applied to decomposition — the quality signal
 * (retrieval scores) decides whether decomposition is needed, not a
 * heuristic or language-specific rule. Works identically across languages.
 *
 * Latency profile:
 *   Simple query (high scores):   ~920ms  (direct retrieval only)
 *   Complex query (low scores):  ~2900ms  (direct + decompose + multi-hop)
 *
 * Implements the Retriever interface — drop-in replacement for FusionRetriever.
 */

import type { Retriever, RetrievalResult, RetrievalOptions } from '../types.js';

/**
 * Callback that decomposes a user query into 1-N sub-queries.
 * Returns a single-element array for single-topic queries (bypass).
 */
export type QueryDecomposer = (query: string) => Promise<string[]>;

export interface MultiHopRetrieverOptions {
  /** The underlying retriever for each sub-query (typically FusionRetriever). */
  retriever: Retriever;
  /**
   * Query decomposer function. Takes a user query and returns sub-queries.
   * When it returns a single-element array, multi-hop is bypassed.
   * Caller-provided to avoid LLM dependency in the rag package.
   */
  decompose: QueryDecomposer;
  /** Maximum sub-queries per decomposition. Default: 3. */
  maxSubQueries?: number;
  /** TopK results per sub-query. Default: 3. */
  subQueryTopK?: number;
  /** Final topK after merge + dedup. Default: 5. */
  topK?: number;
  /**
   * Minimum top-result score to consider direct retrieval "good enough"
   * and skip decomposition. When the top score from direct retrieval
   * meets or exceeds this threshold, the decompose call is skipped
   * entirely — saving ~1000ms of LLM latency.
   *
   * Set to 0 to always decompose (original behavior).
   * Set to 1 to never decompose (direct retrieval only).
   *
   * Default: 0.5 (calibrated for Cohere reranker scores).
   */
  qualityThreshold?: number;
}

export class MultiHopRetriever implements Retriever {
  private readonly retriever: Retriever;
  private readonly decompose: QueryDecomposer;
  private readonly maxSubQueries: number;
  private readonly subQueryTopK: number;
  private readonly defaultTopK: number;
  private readonly qualityThreshold: number;

  constructor(options: MultiHopRetrieverOptions) {
    this.retriever = options.retriever;
    this.decompose = options.decompose;
    this.maxSubQueries = options.maxSubQueries ?? 3;
    this.subQueryTopK = options.subQueryTopK ?? 3;
    this.defaultTopK = options.topK ?? 5;
    this.qualityThreshold = options.qualityThreshold ?? 0.5;
  }

  async retrieve(query: string, options?: RetrievalOptions): Promise<RetrievalResult[]> {
    const topK = options?.topK ?? this.defaultTopK;

    // Phase 1: Direct retrieval (no decomposition cost)
    const directResults = await this.retriever.retrieve(query, options);

    // Quality gate: if direct results are strong, skip decomposition
    if (this.qualityThreshold > 0 && directResults.length > 0) {
      const topScore = Math.max(...directResults.map((r) => r.score ?? 0));
      if (topScore >= this.qualityThreshold) {
        return directResults.slice(0, topK);
      }
    }

    // Phase 2: Direct results were weak — decompose and try multi-hop
    let subQueries: string[];
    try {
      subQueries = await this.decompose(query);
    } catch {
      // Decomposition failed — return the direct results we already have
      return directResults.slice(0, topK);
    }

    const bounded = subQueries.slice(0, this.maxSubQueries);

    // Decomposer returned single query — direct results are the best we have
    if (bounded.length <= 1) {
      return directResults.slice(0, topK);
    }

    // Multi-topic — retrieve for each sub-query in parallel
    const allResults = await Promise.all(
      bounded.map((sq) =>
        this.retriever
          .retrieve(sq, { ...options, topK: this.subQueryTopK })
          .catch((): RetrievalResult[] => []),
      ),
    );

    // Merge: keep highest score per document ID
    const merged = new Map<string, RetrievalResult>();
    for (const results of allResults) {
      for (const result of results) {
        const existing = merged.get(result.id);
        if (!existing || (result.score ?? 0) > (existing.score ?? 0)) {
          merged.set(result.id, result);
        }
      }
    }

    const multiHopResults = Array.from(merged.values())
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, topK);

    // Return multi-hop results if they found anything, otherwise fall back to direct
    return multiHopResults.length > 0 ? multiHopResults : directResults.slice(0, topK);
  }
}
