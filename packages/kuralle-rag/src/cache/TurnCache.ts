/**
 * TurnCache — Per-turn deduplication cache.
 *
 * Prevents redundant retrieval fetches when the same query is executed
 * multiple times within a single turn (e.g., during handoff loops where
 * multiple agents run ContextGather for the same user input).
 *
 * Unlike RetrievalCache (session-level, semantic similarity), TurnCache
 * uses exact query string matching. It is created fresh for each turn
 * and discarded when the turn completes.
 */

import type { RetrievalResult } from '../types.js';

export class TurnCache {
  private readonly cache = new Map<string, RetrievalResult[]>();

  /**
   * Get cached results for an exact query string.
   * Returns undefined on cache miss.
   */
  get(query: string): RetrievalResult[] | undefined {
    return this.cache.get(query);
  }

  /**
   * Store results for a query string.
   */
  set(query: string, results: RetrievalResult[]): void {
    this.cache.set(query, results);
  }

  /**
   * Check if the cache has results for a query.
   */
  has(query: string): boolean {
    return this.cache.has(query);
  }

  /** Number of cached queries. */
  get size(): number {
    return this.cache.size;
  }

  /** Clear all cached entries. */
  clear(): void {
    this.cache.clear();
  }
}
