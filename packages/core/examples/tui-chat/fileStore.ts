/**
 * A tiny JSON-file-backed SessionStore so a conversation survives across separate
 * process invocations — the substrate that lets `send.ts` do adaptive multi-turn
 * (one turn per call). `reviveSession` spreads all keys, so the durable-run state
 * (`durableRuns`: journal + flow position + runEpoch) round-trips through JSON intact.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Session } from '../../src/types/session.js';
import type { SessionStore } from '../../src/session/SessionStore.js';
import { reviveSession } from '../../src/session/utils.js';

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
      const map = readAll();
      map[session.id] = session;
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
