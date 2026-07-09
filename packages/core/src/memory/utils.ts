import type { Session } from '../types/index.js';
import type { MemoryEntry, MemoryIngestionOptions } from './types.js';

/**
 * Extracts `MemoryEntry` objects from a session's user + assistant messages.
 *
 * Used by adapter-backed `MemoryService` implementations (postgres-store,
 * redis-store, etc.) when ingesting a closed session. Each qualifying message
 * becomes one memory; messages with non-string content are flattened via the
 * `text` parts only.
 *
 * Messages that are not role `user` or `assistant`, and messages whose
 * flattened content is empty/whitespace, are skipped.
 *
 * Memory ids are deterministic per-session: `${session.id}:${index}` — this
 * matches the shape that `PostgresMemoryService` and `RedisMemoryService` rely
 * on for idempotent re-ingestion (delete-then-reinsert keeps the `session_id`
 * grouping stable).
 */
export function extractMemories(
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
