/**
 * Pure TypeScript BM25 (Okapi BM25) inverted index for keyword search.
 *
 * Zero external dependencies. Suitable for all runtimes including
 * Cloudflare Workers. Designed for moderate corpus sizes (up to ~100K
 * documents) where an in-process index is viable.
 *
 * BM25 parameters default to the standard values from Robertson & Zaragoza
 * (2009): k1 = 1.2, b = 0.75.
 */

import type { KeywordIndex } from './KeywordIndex.js';

export interface BM25Document {
  /** Unique identifier for this document. */
  id: string;
  /** The text content to index. */
  text: string;
}

export interface BM25SearchResult {
  /** Document ID. */
  id: string;
  /** BM25 relevance score. Higher is more relevant. */
  score: number;
}

export interface BM25IndexOptions {
  /**
   * Term frequency saturation parameter.
   * Higher values increase the impact of term frequency.
   * Default: 1.2.
   */
  k1?: number;
  /**
   * Document length normalization parameter.
   * 0 = no normalization, 1 = full normalization.
   * Default: 0.75.
   */
  b?: number;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/**
 * Minimal tokenizer: lowercase, strip non-alphanumeric (preserve unicode
 * letters), split on whitespace, remove English stop words, drop tokens
 * shorter than 2 characters.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for',
  'if', 'in', 'into', 'is', 'it', 'no', 'not', 'of', 'on', 'or',
  'such', 'that', 'the', 'their', 'then', 'there', 'these', 'they',
  'this', 'to', 'was', 'will', 'with',
]);

/**
 * Shared keyword tokenizer — exported so `Fts5KeywordIndex` queries are
 * tokenized identically to `BM25Index` for ranking parity.
 */
export function tokenizeKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t));
}

const tokenize = tokenizeKeywords;

// ---------------------------------------------------------------------------
// BM25Index
// ---------------------------------------------------------------------------

interface DocEntry {
  id: string;
  length: number;
}

export class BM25Index implements KeywordIndex {
  private readonly k1: number;
  private readonly b: number;

  /** Ordered list of indexed documents. Index = internal doc ordinal. */
  private readonly docs: DocEntry[] = [];
  /** Map from document ID to internal ordinal for deduplication / removal. */
  private readonly idToOrdinal = new Map<string, number>();
  /** Inverted index: term → Set<doc ordinal>. */
  private readonly postings = new Map<string, Set<number>>();
  /** Per-document term frequency: ordinal → Map<term, count>. */
  private readonly termFreqs: Map<string, number>[] = [];
  /** Running sum of document lengths for avgdl computation. */
  private totalLength = 0;

  constructor(options?: BM25IndexOptions) {
    this.k1 = options?.k1 ?? 1.2;
    this.b = options?.b ?? 0.75;
  }

  /** Number of active (non-removed) documents in the index. */
  get size(): number {
    return this.idToOrdinal.size;
  }

  /**
   * Add documents to the index. If a document with the same ID already
   * exists, it is overwritten (old entry is logically removed first).
   */
  add(documents: BM25Document[]): void {
    for (const doc of documents) {
      // Remove existing entry if present (overwrite semantics)
      if (this.idToOrdinal.has(doc.id)) {
        this.remove(doc.id);
      }

      const tokens = tokenize(doc.text);
      const ordinal = this.docs.length;
      const tf = new Map<string, number>();

      for (const token of tokens) {
        tf.set(token, (tf.get(token) ?? 0) + 1);

        let posting = this.postings.get(token);
        if (!posting) {
          posting = new Set();
          this.postings.set(token, posting);
        }
        posting.add(ordinal);
      }

      this.docs.push({ id: doc.id, length: tokens.length });
      this.idToOrdinal.set(doc.id, ordinal);
      this.termFreqs.push(tf);
      this.totalLength += tokens.length;
    }
  }

  /**
   * Remove a document from the index by ID.
   * Returns true if the document existed and was removed.
   */
  remove(id: string): boolean {
    const ordinal = this.idToOrdinal.get(id);
    if (ordinal === undefined) return false;

    const tf = this.termFreqs[ordinal];
    for (const term of tf.keys()) {
      const posting = this.postings.get(term);
      if (posting) {
        posting.delete(ordinal);
        if (posting.size === 0) {
          this.postings.delete(term);
        }
      }
    }

    this.totalLength -= this.docs[ordinal].length;
    // Mark as removed — ordinal slot stays to preserve other ordinals.
    // The doc entry length is set to -1 as a tombstone marker.
    this.docs[ordinal] = { id: '', length: -1 };
    this.termFreqs[ordinal] = new Map();
    this.idToOrdinal.delete(id);

    return true;
  }

  /**
   * Search the index for documents matching the query.
   *
   * @param query - Natural language query (tokenized the same way as documents).
   * @param topK - Maximum number of results. Default: 10.
   * @returns Scored results sorted by BM25 score descending.
   */
  search(query: string, topK = 10): BM25SearchResult[] {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0 || this.docs.length === 0) return [];

    const N = this.idToOrdinal.size; // active (non-tombstoned) doc count
    if (N === 0) return [];

    const avgdl = this.totalLength / N;

    // Accumulate scores per document ordinal
    const scores = new Map<number, number>();

    for (const term of queryTokens) {
      const posting = this.postings.get(term);
      if (!posting) continue;

      const df = posting.size;
      // IDF with floor at 0 to handle edge cases where df > N/2
      const idf = Math.max(
        0,
        Math.log((N - df + 0.5) / (df + 0.5) + 1),
      );

      for (const ordinal of posting) {
        const doc = this.docs[ordinal];
        if (doc.length < 0) continue; // tombstoned

        const tf = this.termFreqs[ordinal].get(term) ?? 0;
        const tfNorm =
          (tf * (this.k1 + 1)) /
          (tf + this.k1 * (1 - this.b + this.b * (doc.length / avgdl)));

        scores.set(ordinal, (scores.get(ordinal) ?? 0) + idf * tfNorm);
      }
    }

    // Sort by score descending, take topK
    const sorted = Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK);

    return sorted.map(([ordinal, score]) => ({
      id: this.docs[ordinal].id,
      score,
    }));
  }

  /** Remove all documents and reset the index. */
  clear(): void {
    this.docs.length = 0;
    this.idToOrdinal.clear();
    this.postings.clear();
    this.termFreqs.length = 0;
    this.totalLength = 0;
  }
}
