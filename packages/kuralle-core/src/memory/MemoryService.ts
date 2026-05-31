import type { Session } from '../types/index.js';
import type { MemoryIngestionOptions, SearchMemoryRequest, SearchMemoryResponse } from './types.js';

/**
 * Interface for cross-session long-term memory.
 *
 * MemoryService is the counterpart to SessionStore:
 * - SessionStore manages per-session state (messages, workingMemory, agentStates)
 * - MemoryService manages cross-session knowledge (facts, summaries, preferences)
 *
 * The service has two responsibilities:
 * 1. Ingestion — converting session data into searchable memories
 * 2. Retrieval — finding relevant memories for a given query
 */
export interface MemoryService {
  /**
   * Ingest a session into long-term memory.
   *
   * Typically called when a session ends or reaches a meaningful checkpoint.
   * Implementations may store raw events, extract facts via LLM, or summarize.
   * A session may be ingested multiple times (implementations must handle idempotency).
   *
   * @param session - The session to ingest
   * @param options - Optional ingestion configuration
   */
  addSessionToMemory(
    session: Session,
    options?: MemoryIngestionOptions,
  ): Promise<void>;

  /**
   * Search long-term memory for relevant context.
   *
   * Returns memories scoped to a specific user within an application context.
   * Implementations may use keyword matching, semantic search, or hybrid approaches.
   *
   * @param request - Search parameters (userId, query, optional filters)
   */
  searchMemory(request: SearchMemoryRequest): Promise<SearchMemoryResponse>;

  /**
   * Delete all memories for a user. Used for GDPR compliance / data cleanup.
   */
  deleteMemories?(userId: string): Promise<void>;
}
