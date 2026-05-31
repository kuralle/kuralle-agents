import type {
  MemoryService,
  MemoryEntry,
  MemoryIngestionOptions,
  SearchMemoryRequest,
  SearchMemoryResponse,
  Session,
} from '@kuralle-agents/core';
import type { RedisClientLike } from './RedisSessionStore.js';
import {
  callCommand,
  getMembers,
  addMembers,
  removeMembers,
  setExpiration,
  getMulti,
} from './redisHelpers.js';

export type RedisMemoryStoreOptions = {
  client: RedisClientLike;
  prefix?: string;
  memoryTtlSeconds?: number;
};

export class RedisMemoryService implements MemoryService {
  private client: RedisClientLike;
  private prefix: string;
  private memoryTtlSeconds?: number;

  constructor(options: RedisMemoryStoreOptions) {
    this.client = options.client;
    this.prefix = options.prefix ?? 'kuralle';
    this.memoryTtlSeconds = options.memoryTtlSeconds;
  }

  /** Key for a single memory entry. */
  private memoryKey(id: string): string {
    return `${this.prefix}:memory:${id}`;
  }

  /** Set of memory IDs belonging to a user. */
  private userMemoryIndexKey(userId: string): string {
    return `${this.prefix}:user:${userId}:memories`;
  }

  /** Set of memory IDs derived from a specific session (for idempotency). */
  private sessionMemoryIndexKey(sessionId: string): string {
    return `${this.prefix}:session:${sessionId}:memories`;
  }

  async addSessionToMemory(
    session: Session,
    options?: MemoryIngestionOptions,
  ): Promise<void> {
    if (!session.userId) return;

    // Idempotency: delete previous memories from this session before re-ingesting.
    const existingIds = await getMembers(this.client, this.sessionMemoryIndexKey(session.id));
    for (const id of existingIds) {
      await callCommand(this.client, ['del'], this.memoryKey(id));
      await removeMembers(this.client, this.userMemoryIndexKey(session.userId), id);
    }
    if (existingIds.length > 0) {
      await callCommand(this.client, ['del'], this.sessionMemoryIndexKey(session.id));
    }

    // Extract memories from session messages.
    const memories = this.extractMemories(session, options);

    for (const memory of memories) {
      const key = this.memoryKey(memory.id);
      await callCommand(this.client, ['set'], key, JSON.stringify(memory));
      if (this.memoryTtlSeconds) {
        await setExpiration(this.client, key, this.memoryTtlSeconds);
      }
      await addMembers(this.client, this.userMemoryIndexKey(session.userId), memory.id);
      await addMembers(this.client, this.sessionMemoryIndexKey(session.id), memory.id);
    }
  }

  async searchMemory(request: SearchMemoryRequest): Promise<SearchMemoryResponse> {
    const { userId, query, limit = 10 } = request;
    const ids = await getMembers(this.client, this.userMemoryIndexKey(userId));
    if (ids.length === 0) return { memories: [] };

    const keys = ids.map(id => this.memoryKey(id));
    const rawEntries = await getMulti(this.client, keys);

    const memories: MemoryEntry[] = [];
    const queryLower = query.toLowerCase();
    const queryTerms = queryLower.split(/\s+/).filter(Boolean);

    for (const raw of rawEntries) {
      if (!raw) continue;
      try {
        const entry: MemoryEntry = JSON.parse(raw);
        entry.createdAt = new Date(entry.createdAt);

        // Keyword scoring: count of query terms found in content.
        const contentLower = entry.content.toLowerCase();
        let matchCount = 0;
        for (const term of queryTerms) {
          if (contentLower.includes(term)) matchCount++;
        }

        if (matchCount > 0) {
          entry.score = matchCount / queryTerms.length;
          memories.push(entry);
        }
      } catch { /* skip malformed entries */ }
    }

    memories.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    return { memories: memories.slice(0, limit) };
  }

  async deleteMemories(userId: string): Promise<void> {
    const ids = await getMembers(this.client, this.userMemoryIndexKey(userId));
    for (const id of ids) {
      await callCommand(this.client, ['del'], this.memoryKey(id));
    }
    await callCommand(this.client, ['del'], this.userMemoryIndexKey(userId));
  }

  /**
   * Extracts MemoryEntry objects from session messages.
   * Strategy 'raw' stores each user/assistant message as a separate memory.
   * Strategies 'summarize' and 'extract' are deferred to a future version.
   */
  private extractMemories(
    session: Session,
    options?: MemoryIngestionOptions,
  ): MemoryEntry[] {
    const memories: MemoryEntry[] = [];
    const now = new Date();

    for (const message of session.messages) {
      if (message.role !== 'user' && message.role !== 'assistant') continue;

      const content = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? (message.content as Array<Record<string, unknown>>)
              .filter((p) => p.type === 'text')
              .map((p) => p.text as string)
              .join('\n')
          : '';

      if (!content.trim()) continue;

      memories.push({
        id: `${session.id}:${memories.length}`,
        sessionId: session.id,
        userId: session.userId!,
        content,
        author: message.role,
        metadata: options?.metadata,
        createdAt: now,
      });
    }

    return memories;
  }
}
