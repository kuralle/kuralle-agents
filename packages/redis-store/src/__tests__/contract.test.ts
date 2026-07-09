/**
 * Shared-contract test wiring for RedisSessionStore.
 *
 * Exercises `runSessionStoreContract` (from core) against the Redis
 * adapter using an in-memory mock RedisClientLike that emulates the
 * subset of commands the adapter issues. Real-instance wiring via
 * Testcontainers lands in Phase 3 — see DECISIONS.md
 * (stores.vector-contract-deferred).
 *
 * RedisVectorStore's `runVectorStoreContract` wiring also requires real
 * Redis Stack (RediSearch + vector distance), so it is deferred. The
 * vector-contract helper itself is already verified against
 * InMemoryVectorStore in @kuralle-agents/rag.
 */

import { describe, expect, test } from 'bun:test';
import { runSessionStoreContract } from '@kuralle-agents/core/session/testing';
import type { ConversationAuditEntry } from '@kuralle-agents/core';

import { RedisSessionStore } from '../RedisSessionStore.js';

function createMockRedisClient() {
  const kv = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const zsets = new Map<string, Map<string, number>>();

  const getSet = (key: string): Set<string> => {
    let s = sets.get(key);
    if (!s) { s = new Set(); sets.set(key, s); }
    return s;
  };
  const getZSet = (key: string): Map<string, number> => {
    let z = zsets.get(key);
    if (!z) { z = new Map(); zsets.set(key, z); }
    return z;
  };

  return {
    async get(key: string) { return kv.get(key) ?? null; },
    async set(key: string, value: string) { kv.set(key, value); return 'OK'; },
    async del(...keys: string[]) {
      let n = 0;
      for (const k of keys) { if (kv.delete(k)) n++; sets.delete(k); zsets.delete(k); }
      return n;
    },
    async mget(keysArg: string | string[], ...rest: string[]) {
      // Accept both `mget(key1, key2, ...)` and `mget([key1, key2, ...])` shapes.
      const keys = Array.isArray(keysArg) ? keysArg : [keysArg, ...rest];
      return keys.map(k => kv.get(k) ?? null);
    },
    async sadd(key: string, ...members: string[]) {
      const s = getSet(key);
      let added = 0;
      for (const m of members) { if (!s.has(m)) { s.add(m); added++; } }
      return added;
    },
    async srem(key: string, ...members: string[]) {
      const s = getSet(key);
      let removed = 0;
      for (const m of members) { if (s.delete(m)) removed++; }
      return removed;
    },
    async smembers(key: string) {
      return Array.from(getSet(key));
    },
    async expire(_key: string, _seconds: number) { return 1; },
    async zadd(key: string, scoreOrEntry: number | { score: number; member: string }, member?: string) {
      if (typeof scoreOrEntry === 'object') {
        getZSet(key).set(scoreOrEntry.member, scoreOrEntry.score);
        return 1;
      }
      getZSet(key).set(member!, scoreOrEntry);
      return 1;
    },
    async zrem(key: string, ...members: string[]) {
      const z = getZSet(key);
      let removed = 0;
      for (const m of members) { if (z.delete(m)) removed++; }
      return removed;
    },
    async zrangebyscore(key: string, min: number | string, max: number | string) {
      const minScore = min === '-inf' ? Number.NEGATIVE_INFINITY : Number(min);
      const maxScore = max === '+inf' ? Number.POSITIVE_INFINITY : Number(max);
      const z = getZSet(key);
      return Array.from(z.entries())
        .filter(([, score]) => score >= minScore && score <= maxScore)
        .sort((a, b) => a[1] - b[1])
        .map(([member]) => member);
    },
    async zremrangebyscore(key: string, min: number, max: number) {
      const z = getZSet(key);
      let removed = 0;
      for (const [member, score] of Array.from(z.entries())) {
        if (score >= min && score <= max) { z.delete(member); removed++; }
      }
      return removed;
    },
  };
}

runSessionStoreContract(() =>
  new RedisSessionStore({ client: createMockRedisClient() as never, enableCleanupIndex: true }),
);

describe('RedisSessionStore audit entries', () => {
  test('appendAuditEntry + listAuditEntries persist chronological filtered entries', async () => {
    const store = new RedisSessionStore({ client: createMockRedisClient() as never, enableCleanupIndex: true });
    await store.save(makeSession('session-audit'));
    await store.appendAuditEntry('session-audit', makeEntry('2026-01-01T00:00:02.000Z', 'agent-end'));
    await store.appendAuditEntry('session-audit', makeEntry('2026-01-01T00:00:01.000Z', 'agent-start'));
    await store.appendAuditEntry('session-audit', makeEntry('2026-01-01T00:00:03.000Z', 'handoff'));

    const entries = await store.listAuditEntries('session-audit', {
      types: ['agent-end', 'handoff'],
      from: new Date('2026-01-01T00:00:01.500Z'),
    });

    expect(entries.map(entry => entry.type)).toEqual(['agent-end', 'handoff']);
  });
});

function makeEntry(
  at: string,
  type: ConversationAuditEntry['type'],
): ConversationAuditEntry {
  if (type === 'handoff') {
    return {
      at,
      sessionId: 'session-audit',
      conversationId: 'conversation-audit',
      type,
      from: 'agent-1',
      to: 'agent-2',
      reason: 'billing',
    };
  }
  return {
    at,
    sessionId: 'session-audit',
    conversationId: 'conversation-audit',
    type,
    agentId: 'agent-1',
    ...(type === 'agent-end' ? { finishReason: 'completed' } : {}),
  } as ConversationAuditEntry;
}

function makeSession(id: string) {
  const now = new Date();
  return {
    id,
    conversationId: 'conversation-audit',
    channelId: 'web',
    createdAt: now,
    updatedAt: now,
    messages: [],
    workingMemory: {},
    currentAgent: 'agent-1',
    activeAgentId: 'agent-1',
    metadata: {
      createdAt: now,
      lastActiveAt: now,
      totalTokens: 0,
      totalSteps: 0,
      handoffHistory: [],
    },
    agentStates: {},
    handoffHistory: [],
  };
}
