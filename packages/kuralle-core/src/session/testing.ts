/// <reference types="bun-types" />
/**
 * Shared contract-test harness for every `SessionStore` adapter.
 *
 * Every store adapter (postgres-store, redis-store, upstash-store, cf-agent
 * durable-object store, memory) MUST pass this contract. Adapters call
 * `runSessionStoreContract(() => new MyStore(...))` from within a `bun test`
 * test file.
 *
 * The harness covers:
 *   - save + get returns the session
 *   - list filters by userId
 *   - delete removes the session
 *   - cleanup (if implemented) drops sessions older than maxAgeMs
 *   - revives nested Date objects
 *
 * Consumers that cannot implement `cleanup` receive an auto-skip.
 *
 * This helper is NOT re-exported from the package's main barrel — import
 * explicitly from `@kuralle-agents/core/session/testing` to avoid pulling
 * `bun:test` into runtime bundles.
 */
import { describe, test, expect, beforeEach } from 'bun:test';

import type { SessionStore } from './SessionStore.js';
import type { Session } from '../types/index.js';

export type SessionStoreFactory = () => SessionStore | Promise<SessionStore>;

const buildSession = (overrides: Partial<Session> = {}): Session => {
  const now = new Date();
  return {
    id: overrides.id ?? 'sess-1',
    conversationId: overrides.conversationId ?? overrides.id ?? 'sess-1',
    channelId: overrides.channelId ?? 'web',
    userId: overrides.userId ?? 'user-1',
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    messages: overrides.messages ?? [],
    workingMemory: overrides.workingMemory ?? {},
    currentAgent: overrides.currentAgent ?? 'main',
    activeAgentId: overrides.activeAgentId,
    state: overrides.state,
    metadata: overrides.metadata ?? {
      createdAt: now,
      lastActiveAt: now,
      totalTokens: 0,
      totalSteps: 0,
      handoffHistory: [],
    },
    agentStates: overrides.agentStates ?? {
      main: { agentId: 'main', state: { k: 'v' }, lastActive: now },
    },
    handoffHistory: overrides.handoffHistory ?? [
      { from: 'a', to: 'b', reason: 'test', timestamp: now },
    ],
  };
};

/**
 * Registers the shared SessionStore contract tests. Must be invoked at the
 * top level of a bun test file.
 */
export function runSessionStoreContract(factory: SessionStoreFactory): void {
  describe('SessionStore contract', () => {
    let store: SessionStore;

    beforeEach(async () => {
      store = await factory();
    });

    test('save + get returns the session', async () => {
      const session = buildSession();
      await store.save(session);
      const fetched = await store.get(session.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(session.id);
      expect(fetched?.userId).toBe(session.userId);
      expect(fetched?.conversationId).toBe(session.conversationId);
      expect(fetched?.channelId).toBe(session.channelId);
    });

    test('get of missing id returns null', async () => {
      expect(await store.get('does-not-exist')).toBeNull();
    });

    test('delete removes the session', async () => {
      const session = buildSession({ id: 'to-delete' });
      await store.save(session);
      await store.delete('to-delete');
      expect(await store.get('to-delete')).toBeNull();
    });

    test('list returns all sessions when no userId', async () => {
      await store.save(buildSession({ id: 'a', userId: 'u1' }));
      await store.save(buildSession({ id: 'b', userId: 'u2' }));
      const all = await store.list();
      const ids = all.map(s => s.id).sort();
      expect(ids).toContain('a');
      expect(ids).toContain('b');
    });

    test('list filters by userId', async () => {
      await store.save(buildSession({ id: 'a', userId: 'u1' }));
      await store.save(buildSession({ id: 'b', userId: 'u2' }));
      const only = await store.list('u1');
      expect(only.map(s => s.id)).toEqual(['a']);
    });

    test('revives nested Date objects (createdAt, updatedAt, handoffHistory, agentStates)', async () => {
      const session = buildSession({ id: 'dates' });
      await store.save(session);
      const fetched = await store.get('dates');
      expect(fetched).not.toBeNull();
      expect(fetched!.createdAt).toBeInstanceOf(Date);
      expect(fetched!.updatedAt).toBeInstanceOf(Date);
      expect(fetched!.handoffHistory[0]?.timestamp).toBeInstanceOf(Date);
      expect(fetched!.agentStates.main?.lastActive).toBeInstanceOf(Date);
      if (fetched!.metadata) {
        expect(fetched!.metadata.createdAt).toBeInstanceOf(Date);
        expect(fetched!.metadata.lastActiveAt).toBeInstanceOf(Date);
      }
    });

    test('cleanup drops sessions older than maxAgeMs (skipped when unsupported)', async () => {
      if (!store.cleanup) return;
      const stale = buildSession({ id: 'stale' });
      stale.updatedAt = new Date(Date.now() - 10_000);
      const fresh = buildSession({ id: 'fresh' });
      await store.save(stale);
      await store.save(fresh);
      await store.cleanup(1_000);
      expect(await store.get('fresh')).not.toBeNull();
    });
  });
}
