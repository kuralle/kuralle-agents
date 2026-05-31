import { randomUUID } from 'node:crypto';
import type { Session } from '../../types/index.js';
import type { MemoryService } from '../MemoryService.js';
import type {
  MemoryEntry,
  MemoryIngestionOptions,
  SearchMemoryRequest,
  SearchMemoryResponse,
} from '../types.js';

/**
 * Extracts plain text from a message content field.
 * Handles both string content and array content parts.
 */
function extractTextFromMessage(message: { role: string; content: unknown }): string {
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return (message.content as Array<Record<string, unknown>>)
      .filter((part) => part.type === 'text')
      .map((part) => part.text as string)
      .join('\n');
  }
  return '';
}

/**
 * Extracts lowercase words from text as a Set for fast lookup.
 */
function extractWordsLower(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean),
  );
}

/**
 * In-memory implementation of MemoryService for development and testing.
 *
 * Uses keyword-based search with term overlap scoring.
 * All data is stored in-process and lost on restart.
 */
export class InMemoryMemoryService implements MemoryService {
  /**
   * In-memory storage indexed by userId.
   * Each user has a map of sessionId → MemoryEntry[].
   */
  private memories: Map<string, Map<string, MemoryEntry[]>> = new Map();

  async addSessionToMemory(
    session: Session,
    options?: MemoryIngestionOptions,
  ): Promise<void> {
    if (!session.userId) return;

    const entries: MemoryEntry[] = [];
    for (const message of session.messages) {
      if (message.role !== 'user' && message.role !== 'assistant') continue;

      const text = extractTextFromMessage(message);
      if (!text.trim()) continue;

      entries.push({
        id: randomUUID(),
        sessionId: session.id,
        userId: session.userId,
        content: text,
        author: message.role === 'user' ? 'user' : 'assistant',
        metadata: options?.metadata,
        createdAt: new Date(),
      });
    }

    // Idempotency: delete existing entries for this session before re-ingesting
    const userMemories = this.memories.get(session.userId) ?? new Map<string, MemoryEntry[]>();
    userMemories.set(session.id, entries);
    this.memories.set(session.userId, userMemories);
  }

  async searchMemory(request: SearchMemoryRequest): Promise<SearchMemoryResponse> {
    const userMemories = this.memories.get(request.userId);
    if (!userMemories) return { memories: [] };

    const queryWords = extractWordsLower(request.query);
    if (queryWords.size === 0) return { memories: [] };

    const matches: MemoryEntry[] = [];

    for (const entries of userMemories.values()) {
      for (const entry of entries) {
        const entryWords = extractWordsLower(entry.content);
        let matchCount = 0;
        for (const w of queryWords) {
          if (entryWords.has(w)) matchCount++;
        }
        if (matchCount > 0) {
          matches.push({ ...entry, score: matchCount / queryWords.size });
        }
      }
    }

    // Sort by relevance score descending
    matches.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return { memories: matches.slice(0, request.limit ?? 10) };
  }

  async deleteMemories(userId: string): Promise<void> {
    this.memories.delete(userId);
  }
}
