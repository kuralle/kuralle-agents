import type {
  Reranker,
  RetrievalResult,
  RerankerOptions,
} from '../types.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface CohereRerankerOptions {
  /**
   * Cohere API key. If not provided, reads from the COHERE_API_KEY
   * environment variable at call time.
   */
  apiKey?: string;
  /**
   * Cohere rerank model identifier.
   * Default: 'rerank-v3.5'.
   */
  model?: string;
  /** Maximum number of results to return after reranking. Default: 5. */
  topK?: number;
  /**
   * Cohere API base URL. Override for proxied or self-hosted endpoints.
   * Default: 'https://api.cohere.com/v2'.
   */
  baseUrl?: string;
  /**
   * Maximum characters of document text to send per candidate.
   * Cohere's rerank API accepts up to 4096 tokens per document;
   * truncating to character limit avoids oversized requests.
   * Default: 4000.
   */
  maxCharsPerDoc?: number;
}

// ---------------------------------------------------------------------------
// Cohere API response types (subset)
// ---------------------------------------------------------------------------

interface CohereRerankResponse {
  results: Array<{
    index: number;
    relevance_score: number;
  }>;
}

// ---------------------------------------------------------------------------
// CohereReranker
// ---------------------------------------------------------------------------

/**
 * Reranker backed by the Cohere Rerank API.
 *
 * Uses `fetch()` directly — no SDK dependency. Compatible with all
 * runtimes including Cloudflare Workers, Vercel Edge, and Deno Deploy.
 *
 * The Cohere Rerank API accepts a query and a list of documents, and
 * returns relevance scores for each document. This reranker maps those
 * scores back onto RetrievalResult objects and sorts by relevance.
 */
export class CohereReranker implements Reranker {
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly defaultTopK: number;
  private readonly baseUrl: string;
  private readonly maxCharsPerDoc: number;

  constructor(options?: CohereRerankerOptions) {
    this.apiKey = options?.apiKey;
    this.model = options?.model ?? 'rerank-v3.5';
    this.defaultTopK = options?.topK ?? 5;
    this.baseUrl = options?.baseUrl ?? 'https://api.cohere.com/v2';
    this.maxCharsPerDoc = options?.maxCharsPerDoc ?? 4000;
  }

  async rerank(
    query: string,
    results: RetrievalResult[],
    options?: RerankerOptions,
  ): Promise<RetrievalResult[]> {
    const topK = options?.topK ?? this.defaultTopK;

    if (results.length === 0) return [];

    // Short-circuit: if fewer results than topK, still rerank for scoring
    const key = this.resolveApiKey();

    const documents = results.map(r =>
      r.text.slice(0, this.maxCharsPerDoc),
    );

    const response = await fetch(`${this.baseUrl}/rerank`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents,
        top_n: topK,
        return_documents: false,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'unknown error');
      throw new Error(
        `Cohere Rerank API error (${response.status}): ${errorBody}`,
      );
    }

    const body = (await response.json()) as CohereRerankResponse;

    // Map Cohere results back to RetrievalResult, sorted by relevance
    return body.results
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .map(r => ({
        ...results[r.index],
        score: r.relevance_score,
        relevanceScore: r.relevance_score,
      }));
  }

  private resolveApiKey(): string {
    const key = this.apiKey ?? (typeof process !== 'undefined'
      ? process.env?.COHERE_API_KEY
      : undefined);
    if (!key) {
      throw new Error(
        'CohereReranker: No API key provided. Pass apiKey in options ' +
        'or set the COHERE_API_KEY environment variable.',
      );
    }
    return key;
  }
}
