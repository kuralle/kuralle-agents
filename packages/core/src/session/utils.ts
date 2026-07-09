import type { Session } from '../types/index.js';

/**
 * Restores a Session from its serialized form.
 *
 * Revives Date instances nested in:
 *  - top-level `createdAt` / `updatedAt`
 *  - `handoffHistory[].timestamp`
 *  - `metadata.createdAt` / `metadata.lastActiveAt`
 *  - `metadata.handoffHistory[].timestamp`
 *  - `agentStates[*].lastActive`
 *
 * Adapter packages (postgres-store, redis-store, upstash-store, etc.) must
 * import this instead of re-implementing their own revival logic.
 *
 * The input may be a JSON string (e.g. from a Redis GET) or an already-parsed
 * object (e.g. a JSONB column from Postgres). Other shapes pass through
 * untouched in the key fields — callers are expected to have validated shape.
 */
export function reviveSession(raw: unknown): Session {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const source = parsed as Session;
  const session = { ...source } as Session;

  session.createdAt = new Date(source.createdAt);
  session.updatedAt = new Date(source.updatedAt);
  session.handoffHistory = (source.handoffHistory ?? []).map(record => ({
    ...record,
    timestamp: new Date(record.timestamp),
  }));

  if (source.metadata) {
    session.metadata = {
      ...source.metadata,
      createdAt: new Date(source.metadata.createdAt),
      lastActiveAt: new Date(source.metadata.lastActiveAt),
      handoffHistory: (source.metadata.handoffHistory ?? []).map(record => ({
        ...record,
        timestamp: new Date(record.timestamp),
      })),
    };
  }

  session.agentStates = Object.fromEntries(
    Object.entries(source.agentStates ?? {}).map(([agentId, state]) => [
      agentId,
      {
        ...state,
        lastActive: new Date(state.lastActive),
      },
    ])
  );

  return session;
}
