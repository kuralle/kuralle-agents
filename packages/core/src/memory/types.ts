/**
 * Types for the cross-session long-term memory system.
 *
 * These types define the data structures used by MemoryService implementations
 * for storing, searching, and managing cross-session knowledge.
 */

export interface MemoryEntry {
  /** Unique identifier for this memory */
  id: string;

  /** The session this memory was derived from */
  sessionId: string;

  /** The user this memory belongs to */
  userId: string;

  /** The memory content (extracted fact, summary, or raw text) */
  content: string;

  /** Who authored the original content: 'user' | 'assistant' | agent name */
  author?: string;

  /** Structured metadata for filtering */
  metadata?: Record<string, unknown>;

  /** When the memory was created */
  createdAt: Date;

  /** Relevance score (populated by search, not storage) */
  score?: number;
}

export interface SearchMemoryRequest {
  /** Required: whose memories to search */
  userId: string;

  /** The search query */
  query: string;

  /** Max results to return (default: 10) */
  limit?: number;

  /** Optional metadata filters */
  filter?: Record<string, unknown>;
}

export interface SearchMemoryResponse {
  memories: MemoryEntry[];
}

export interface MemoryIngestionOptions {
  /** Custom metadata to attach to all memories from this session */
  metadata?: Record<string, unknown>;

  /**
   * Ingestion strategy:
   * - 'raw': Store message content as-is (default for InMemoryMemoryService)
   * - 'summarize': Use LLM to summarize the session before storing
   * - 'extract': Use LLM to extract individual facts/entities
   */
  strategy?: 'raw' | 'summarize' | 'extract';
}
