import type {
  Retriever,
  RetrievalResult,
  RetrievalOptions,
} from '../types.js';

export interface HybridRetrieverSource {
  /** The retriever to include in the hybrid. */
  retriever: Retriever;
  /** Relative weight for this retriever in fusion scoring. Default: 1.0. */
  weight?: number;
}

export interface HybridRetrieverOptions {
  /** The retrievers to combine. */
  sources: HybridRetrieverSource[];
  /**
   * The k parameter for reciprocal rank fusion.
   * Higher values give more weight to lower-ranked results.
   * Default: 60 (standard RRF constant).
   */
  k?: number;
  /** Default number of results to return. Default: 10. */
  topK?: number;
}

/**
 * Retriever that combines multiple retrieval strategies using
 * reciprocal rank fusion (RRF).
 *
 * RRF is a rank-based fusion method that does not require score
 * normalization across retrievers. It works well when combining
 * retrievers with incompatible scoring scales (e.g., cosine similarity
 * from a vector store with BM25 scores from keyword search).
 *
 * Reference: Cormack, Clarke, Buettcher. "Reciprocal Rank Fusion
 * outperforms Condorcet and individual Rank Learning Methods." (2009)
 */
export class HybridRetriever implements Retriever {
  private readonly sources: HybridRetrieverSource[];
  private readonly k: number;
  private readonly defaultTopK: number;

  constructor(options: HybridRetrieverOptions) {
    this.sources = options.sources;
    this.k = options.k ?? 60;
    this.defaultTopK = options.topK ?? 10;
  }

  async retrieve(
    query: string,
    options?: RetrievalOptions,
  ): Promise<RetrievalResult[]> {
    const topK = options?.topK ?? this.defaultTopK;

    // Run all retrievers in parallel
    const allResults = await Promise.all(
      this.sources.map(s => s.retriever.retrieve(query, options)),
    );

    // Reciprocal rank fusion
    const fusedScores = new Map<string, number>();
    const bestResult = new Map<string, RetrievalResult>();

    for (let i = 0; i < allResults.length; i++) {
      const weight = this.sources[i].weight ?? 1.0;
      const results = allResults[i];
      for (let rank = 0; rank < results.length; rank++) {
        const result = results[rank];
        const rrfScore = weight / (this.k + rank + 1);
        fusedScores.set(
          result.id,
          (fusedScores.get(result.id) ?? 0) + rrfScore,
        );
        // Keep the result with the highest original score for metadata
        const existing = bestResult.get(result.id);
        if (!existing || (result.score ?? 0) > (existing.score ?? 0)) {
          bestResult.set(result.id, result);
        }
      }
    }

    // Sort by fused score, return top K
    const sorted = Array.from(fusedScores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK);

    return sorted.map(([id, rrfScore]) => {
      const result = bestResult.get(id)!;
      return {
        ...result,
        score: rrfScore,
        relevanceScore: rrfScore,
      };
    });
  }
}
