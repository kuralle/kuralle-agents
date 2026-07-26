/**
 * A tiny JSON-file-backed SessionStore so a conversation survives across separate
 * process invocations — the substrate that lets `send` do adaptive multi-turn
 * (one turn per call). `reviveSession` spreads all keys, so the durable-run state
 * (`durableRuns`: journal + flow position + runEpoch) round-trips through JSON intact.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Session, SessionStore } from '@kuralle-agents/core';
import { reviveSession, StaleWriteError } from '@kuralle-agents/core';

export function fileSessionStore(path: string): SessionStore {
  const readAll = (): Record<string, unknown> => {
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const writeAll = (map: Record<string, unknown>): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(map));
  };
  return {
    async get(id: string): Promise<Session | null> {
      const map = readAll();
      return map[id] ? reviveSession(map[id]) : null;
    },
    async save(session: Session): Promise<void> {
      // Compare-and-swap, matching MemoryStore. The durable journal appends through
      // `mutateSessionWithRetry`, which retries on StaleWriteError — a store that accepts
      // a stale write silently drops the losing append instead, and the step it wrote is
      // then missing when finalizeStep looks for it.
      const map = readAll();
      const existing = map[session.id] as Session | undefined;
      const expected = session.version ?? 0;
      const stored = existing ? (existing.version ?? 0) : 0;
      if (stored !== expected) {
        throw new StaleWriteError(session.id, expected, stored);
      }
      map[session.id] = { ...session, updatedAt: new Date(), version: expected + 1 };
      writeAll(map);
    },
    async delete(id: string): Promise<void> {
      const map = readAll();
      delete map[id];
      writeAll(map);
    },
    async list(userId?: string): Promise<Session[]> {
      return Object.values(readAll())
        .map((raw) => reviveSession(raw))
        .filter((s) => (userId ? s.userId === userId : true));
    },
  };
}