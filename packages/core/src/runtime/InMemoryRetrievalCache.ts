import type { KnowledgeRetrievalResult, RetrievalCacheAdapter } from '../types/knowledge.js';

/**
 * Zero-config, in-process session retrieval cache (G6). Keyed by the query
 * embedding: a lookup returns the cached results of the most-similar recent
 * query (cosine ≥ threshold, within TTL). LRU-bounded. Needs only the embedder
 * the KnowledgeProvider already requires — no external dependency. Apps that
 * want a shared/vector-backed cache can inject their own `RetrievalCacheAdapter`
 * via the KnowledgeProvider's `cacheFactory` instead.
 */
export interface InMemoryRetrievalCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  similarityThreshold?: number;
}

interface CacheEntry {
  embedding: readonly number[];
  results: KnowledgeRetrievalResult[];
  at: number;
}

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class InMemoryRetrievalCache implements RetrievalCacheAdapter {
  /** Ordered oldest → newest (LRU front, MRU back). */
  private entries: CacheEntry[] = [];
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly threshold: number;

  constructor(options: InMemoryRetrievalCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 256;
    this.ttlMs = options.ttlMs ?? 300_000;
    this.threshold = options.similarityThreshold ?? 0.85;
  }

  get size(): number {
    return this.entries.length;
  }

  lookup(queryEmbedding: readonly number[], topK?: number): KnowledgeRetrievalResult[] {
    const now = Date.now();
    let best: CacheEntry | undefined;
    let bestSim = this.threshold;
    for (const entry of this.entries) {
      if (now - entry.at > this.ttlMs) continue;
      const sim = cosineSimilarity(queryEmbedding, entry.embedding);
      if (sim >= bestSim) {
        bestSim = sim;
        best = entry;
      }
    }
    if (!best) return [];
    // Touch: move to MRU.
    this.entries = this.entries.filter((e) => e !== best);
    this.entries.push(best);
    const results = best.results;
    return topK === undefined ? results : results.slice(0, topK);
  }

  populate(results: KnowledgeRetrievalResult[], queryEmbedding?: readonly number[]): void {
    if (!queryEmbedding || queryEmbedding.length === 0 || results.length === 0) return;
    this.entries.push({ embedding: queryEmbedding, results: [...results], at: Date.now() });
    while (this.entries.length > this.maxEntries) this.entries.shift();
  }
}
