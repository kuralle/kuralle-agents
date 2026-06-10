/**
 * RetrievalQualityChecker — CRAG three-bucket quality assessment.
 *
 * Evaluates retrieval results using score distribution (sub-millisecond,
 * arithmetic only). When quality is low, optionally triggers query
 * reformulation for text agents (inline) or fires background
 * reformulation for voice agents (via pre-fetcher).
 *
 * The `reformulate` callback is caller-provided to avoid coupling the
 * rag package to any LLM provider.
 */

import type { RetrievalResult } from '../types.js';

export interface QualityCheckResult {
  /** Quality bucket: high, medium, or low. */
  quality: 'high' | 'medium' | 'low';
  /** Highest relevance score in the result set. */
  topScore: number;
  /** Mean relevance score across all results. */
  avgScore: number;
  /** 0-1 estimate of how well results cover the query. */
  coverageEstimate: number;
  /**
   * Estimated prompt-token cost of the result set (~chars/4). Retrieval
   * pays for itself in tokens — track this to catch a retriever that is
   * "accurate" only by flooding the context window.
   */
  estimatedTokens: number;
  /** Whether the query was reformulated and re-retrieved. */
  reformulated: boolean;
  /** The reformulated query string, if reformulation occurred. */
  reformulatedQuery?: string;
  /** Whether background reformulation was triggered (voice agents). */
  backgroundReformulation?: boolean;
}

/**
 * Callback that reformulates a low-quality query. Takes the original
 * query and the weak results, returns a rewritten query string.
 */
export type QueryReformulator = (query: string, results: RetrievalResult[]) => Promise<string>;

export interface RetrievalQualityCheckerOptions {
  /**
   * Minimum top-result score to consider quality "high". Default: 0.5.
   *
   * These defaults are calibrated for post-reranker scores (e.g., Cohere
   * Rerank v3.5 which returns absolute [0,1] relevance). Without a reranker,
   * FusionRetriever's min-max normalization produces scores near 1.0 for
   * the top result, making these thresholds effectively inert. If you are
   * not using a reranker, either tune these thresholds to your score
   * distribution or skip quality checking.
   */
  highThreshold?: number;
  /** Minimum top-result score to consider quality "medium". Default: 0.3. */
  mediumThreshold?: number;
  /**
   * Optional query reformulator. When provided and quality is "low",
   * the checker rewrites the query and returns the reformulated version.
   *
   * For voice agents: this should be wired to the PredictivePreFetcher
   * to reformulate in the background, not in the hot path.
   */
  reformulate?: QueryReformulator;
}

export class RetrievalQualityChecker {
  private readonly highThreshold: number;
  private readonly mediumThreshold: number;
  private readonly reformulate?: QueryReformulator;

  constructor(options?: RetrievalQualityCheckerOptions) {
    this.highThreshold = options?.highThreshold ?? 0.5;
    this.mediumThreshold = options?.mediumThreshold ?? 0.3;
    this.reformulate = options?.reformulate;
  }

  /**
   * Assess retrieval quality based on score distribution.
   * The score check itself is sub-millisecond (pure arithmetic).
   */
  assess(results: RetrievalResult[]): Omit<QualityCheckResult, 'reformulated' | 'reformulatedQuery' | 'backgroundReformulation'> {
    if (results.length === 0) {
      return { quality: 'low', topScore: 0, avgScore: 0, coverageEstimate: 0, estimatedTokens: 0 };
    }

    const scores = results.map((r) => r.score ?? 0);
    const topScore = Math.max(...scores);
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    const estimatedTokens = results.reduce((s, r) => s + Math.ceil(r.text.length / 4), 0);

    // Coverage: fraction of results above the medium threshold
    const aboveThreshold = scores.filter((s) => s >= this.mediumThreshold).length;
    const coverageEstimate = aboveThreshold / results.length;

    let quality: 'high' | 'medium' | 'low';
    if (topScore >= this.highThreshold) {
      quality = 'high';
    } else if (topScore >= this.mediumThreshold) {
      quality = 'medium';
    } else {
      quality = 'low';
    }

    return { quality, topScore, avgScore, coverageEstimate, estimatedTokens };
  }

  /**
   * Full quality check with optional reformulation for text agents.
   *
   * @param query - The original user query.
   * @param results - Retrieval results to evaluate.
   * @param isVoice - Whether this is a voice agent (reformulation goes to background).
   * @returns Quality assessment with optional reformulated query.
   */
  async check(
    query: string,
    results: RetrievalResult[],
    isVoice = false,
  ): Promise<QualityCheckResult> {
    const assessment = this.assess(results);

    if (assessment.quality !== 'low' || !this.reformulate) {
      return { ...assessment, reformulated: false };
    }

    // Voice agents: signal that background reformulation should occur,
    // but don't block the hot path. The caller (KnowledgeProvider)
    // fires the pre-fetcher in the background.
    if (isVoice) {
      return {
        ...assessment,
        reformulated: false,
        backgroundReformulation: true,
      };
    }

    // Text agents: reformulate inline
    try {
      const reformulatedQuery = await this.reformulate(query, results);
      return {
        ...assessment,
        reformulated: true,
        reformulatedQuery,
      };
    } catch {
      // Reformulation failed — return original assessment
      return { ...assessment, reformulated: false };
    }
  }
}
