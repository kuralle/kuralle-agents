import type { BM25Document, BM25SearchResult } from './BM25Index.js';

/**
 * Contract for a BM25-ranked keyword index — the keyword tier of hybrid
 * retrieval. Implementations: `BM25Index` (in-memory, rebuilt per process)
 * and `Fts5KeywordIndex` (SQLite FTS5, persistent — survives Durable
 * Object hibernation with zero rebuild).
 *
 * All methods are synchronous: the in-memory index is pure computation and
 * DO SQLite's `sql.exec` is synchronous, so the contract stays sync to keep
 * `FusionRetriever` / `KnowledgeFs` hot paths allocation-free.
 */
export interface KeywordIndex {
  /** Number of documents in the index. */
  readonly size: number;

  /**
   * Add documents. A document with an existing ID is overwritten.
   */
  add(documents: BM25Document[]): void;

  /**
   * Remove a document by ID. Returns true if it existed.
   */
  remove(id: string): boolean;

  /**
   * Search for documents matching the query, BM25-scored, descending.
   */
  search(query: string, topK?: number): BM25SearchResult[];

  /** Remove all documents. */
  clear(): void;
}
