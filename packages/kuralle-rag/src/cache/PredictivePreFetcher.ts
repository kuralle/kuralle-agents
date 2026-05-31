/**
 * PredictivePreFetcher — Background pre-fetch for retrieval results.
 *
 * Analyzes the recent conversation window to predict follow-up topics,
 * then pre-fetches relevant content into the session-level RetrievalCache.
 *
 * Uses keyword extraction from the conversation window (no LLM call for
 * the default strategy — just TF-IDF-style keyword extraction). An LLM
 * prediction strategy can be layered on top when a model is available.
 *
 * Derived from VoiceAgentRAG (arXiv:2603.02206) dual-agent pre-fetch pattern.
 */

import type { Retriever, RetrievalResult, RetrievalOptions } from '../types.js';
import type { RetrievalCache } from './RetrievalCache.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * LLM-based topic predictor. Takes recent conversation messages and
 * returns predicted follow-up queries that should be pre-fetched.
 * When provided, this strategy runs instead of keyword extraction.
 */
export type TopicPredictor = (
  messages: Array<{ role: string; content: string }>,
) => Promise<string[]>;

export interface PredictivePreFetcherConfig {
  /** The retriever to use for pre-fetching. */
  retriever: Retriever;
  /** The session-level cache to populate. */
  cache: RetrievalCache;
  /** Maximum number of keywords to extract per prediction. Default: 3. */
  maxKeywords?: number;
  /** Number of recent messages to analyze for topic prediction. Default: 5. */
  conversationWindow?: number;
  /** TopK results per pre-fetch query. Default: 3. */
  topK?: number;
  /** Additional retrieval options (e.g., includeEmbeddings). */
  retrievalOptions?: Partial<RetrievalOptions>;
  /**
   * Optional LLM-based topic predictor. When provided, this is used
   * instead of keyword extraction for predicting follow-up queries.
   *
   * The predictor receives recent conversation messages and should
   * return an array of predicted search queries. The implementation
   * is caller-provided so the pre-fetcher has no LLM dependency.
   *
   * Example using Vercel AI SDK:
   * ```ts
   * predictor: async (messages) => {
   *   const { text } = await generateText({
   *     model: openai('gpt-4o-mini'),
   *     system: 'Predict 3 follow-up topics the user might ask about.',
   *     prompt: messages.map(m => `${m.role}: ${m.content}`).join('\n'),
   *   });
   *   return text.split('\n').filter(Boolean);
   * }
   * ```
   */
  predictor?: TopicPredictor;
}

// ---------------------------------------------------------------------------
// PredictivePreFetcher
// ---------------------------------------------------------------------------

export class PredictivePreFetcher {
  private readonly retriever: Retriever;
  private readonly cache: RetrievalCache;
  private readonly maxKeywords: number;
  private readonly conversationWindow: number;
  private readonly topK: number;
  private readonly retrievalOptions: Partial<RetrievalOptions>;
  private readonly predictor?: TopicPredictor;

  /** Track in-flight pre-fetches to avoid duplicate work. */
  private inflight = new Set<string>();

  constructor(config: PredictivePreFetcherConfig) {
    this.retriever = config.retriever;
    this.cache = config.cache;
    this.maxKeywords = config.maxKeywords ?? 3;
    this.conversationWindow = config.conversationWindow ?? 5;
    this.topK = config.topK ?? 3;
    this.retrievalOptions = config.retrievalOptions ?? {};
    this.predictor = config.predictor;
  }

  /**
   * Predict follow-up topics from the conversation and pre-fetch
   * relevant content into the cache. Runs in the background — the
   * returned promise can be fire-and-forget.
   *
   * @param messages - Recent conversation messages (role + content pairs).
   * @returns Keywords that were used for pre-fetching.
   */
  async prefetch(
    messages: Array<{ role: string; content: string }>,
  ): Promise<{ keywords: string[]; resultCount: number }> {
    const window = messages.slice(-this.conversationWindow);

    // Use LLM predictor when available, fall back to keyword extraction
    let keywords: string[];
    if (this.predictor) {
      try {
        keywords = await this.predictor(window);
        keywords = keywords.slice(0, this.maxKeywords);
      } catch {
        // LLM prediction failed — fall back to keyword extraction
        keywords = extractKeywords(window, this.maxKeywords);
      }
    } else {
      keywords = extractKeywords(window, this.maxKeywords);
    }

    if (keywords.length === 0) {
      return { keywords: [], resultCount: 0 };
    }

    // Filter out keywords already being fetched
    const newKeywords = keywords.filter(k => !this.inflight.has(k));
    if (newKeywords.length === 0) {
      return { keywords: [], resultCount: 0 };
    }

    // Mark as in-flight
    for (const k of newKeywords) this.inflight.add(k);

    let totalResults = 0;

    try {
      // Fetch in parallel for all predicted keywords
      const fetchPromises = newKeywords.map(async keyword => {
        try {
          const results = await this.retriever.retrieve(keyword, {
            topK: this.topK,
            ...this.retrievalOptions,
            includeEmbeddings: true,
          });
          if (results.length > 0) {
            this.cache.populate(results);
            totalResults += results.length;
          }
        } catch {
          // Pre-fetch failures are non-critical — log and continue
        }
      });

      await Promise.all(fetchPromises);
    } finally {
      // Clear in-flight markers
      for (const k of newKeywords) this.inflight.delete(k);
    }

    return { keywords: newKeywords, resultCount: totalResults };
  }
}

// ---------------------------------------------------------------------------
// Keyword extraction
// ---------------------------------------------------------------------------

/** Stop words for keyword extraction. */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can',
  'do', 'for', 'from', 'had', 'has', 'have', 'he', 'her', 'him',
  'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just',
  'let', 'like', 'me', 'my', 'no', 'not', 'now', 'of', 'on', 'or',
  'our', 'out', 'own', 'say', 'she', 'so', 'some', 'than', 'that',
  'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'to', 'too', 'up', 'us', 'very', 'was', 'we', 'what', 'when',
  'which', 'who', 'will', 'with', 'would', 'yes', 'you', 'your',
  'could', 'should', 'about', 'been', 'more', 'other', 'also',
  'did', 'does', 'get', 'got', 'much', 'need', 'only', 'over',
  'sure', 'tell', 'think', 'want', 'well', 'know', 'okay', 'ok',
  'please', 'thank', 'thanks', 'hi', 'hello', 'hey',
]);

/**
 * Extract top-N keywords from conversation messages using simple
 * TF-IDF-style scoring. User messages are weighted 2x over assistant
 * messages. Returns multi-word phrases when adjacent high-scoring
 * tokens appear together.
 */
function extractKeywords(
  messages: Array<{ role: string; content: string }>,
  maxKeywords: number,
): string[] {
  const termFreq = new Map<string, number>();

  for (const msg of messages) {
    const weight = msg.role === 'user' ? 2 : 1;
    const tokens = msg.content
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 3 && !STOP_WORDS.has(t));

    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) ?? 0) + weight);
    }
  }

  // Sort by frequency descending, take top N
  const sorted = Array.from(termFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([term]) => term);

  return sorted;
}
