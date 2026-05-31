/**
 * Shared-contract test wiring for PostgresSessionStore.
 *
 * Exercises the helper `runSessionStoreContract` (from core) against the
 * Postgres adapter using an in-memory mock PostgresClient that emulates
 * the statements the adapter issues. The same mock pattern is already
 * used by PostgresMemoryService.test.js.
 *
 * PgVectorStore's contract wiring (runVectorStoreContract) requires a real
 * pgvector instance — Testcontainers wiring is deferred to a Phase-3
 * follow-up, tracked in DECISIONS.md (stores.vector-contract-deferred).
 * The helper itself is already exercised end-to-end against
 * InMemoryVectorStore in packages/kuralle-rag.
 */

import { describe, expect, test } from 'bun:test';
import { runSessionStoreContract } from '@kuralle-agents/core/session/testing';
import type { ConversationAuditEntry } from '@kuralle-agents/core';

import { PostgresSessionStore } from '../PostgresSessionStore.js';

type MockRow = { id: string; user_id: string | null; conversation_id: string; channel_id: string; data: string; updated_at: Date };
type MockAuditRow = { id: number; session_id: string; at: Date; type: string; payload: string };

function createMockPgClient() {
  const sessions: MockRow[] = [];
  const auditEntries: MockAuditRow[] = [];
  let nextAuditId = 1;
  return {
    async query(text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
      const sql = text.trim();

      if (sql.startsWith('CREATE TABLE') || sql.startsWith('CREATE INDEX')) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.startsWith('ALTER TABLE') || sql.startsWith('UPDATE')) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.startsWith('SELECT data FROM') && sql.includes('WHERE id =')) {
        const [id] = params as [string];
        const row = sessions.find(r => r.id === id);
        return { rows: row ? [{ data: row.data }] : [], rowCount: row ? 1 : 0 };
      }

      if (sql.startsWith('SELECT data FROM') && sql.includes('WHERE user_id =')) {
        const [userId] = params as [string];
        const rows = sessions
          .filter(r => r.user_id === userId)
          .map(r => ({ data: r.data }));
        return { rows, rowCount: rows.length };
      }

      if (sql.startsWith('SELECT data FROM')) {
        const rows = sessions.map(r => ({ data: r.data }));
        return { rows, rowCount: rows.length };
      }

      if (sql.startsWith('INSERT INTO') && sql.includes('audit_entries')) {
        const [sessionId, at, type, payload] = params as [string, Date, string, string];
        auditEntries.push({
          id: nextAuditId++,
          session_id: sessionId,
          at,
          type,
          payload,
        });
        return { rows: [], rowCount: 1 };
      }

      if (sql.startsWith('SELECT payload FROM') && sql.includes('audit_entries')) {
        const [sessionId, from, to, types] = params as [string, Date | undefined, Date | undefined, string[] | undefined];
        let rows = auditEntries.filter(row => row.session_id === sessionId);
        if (sql.includes('at >=') && from instanceof Date) rows = rows.filter(row => row.at >= from);
        if (sql.includes('at <=')) {
          const toParam = params.find((param, index) => index > 0 && param instanceof Date && param !== from) as Date | undefined;
          if (toParam) rows = rows.filter(row => row.at <= toParam);
        }
        const typesParam = params.find(Array.isArray) as string[] | undefined ?? types;
        if (typesParam && typesParam.length > 0) rows = rows.filter(row => typesParam.includes(row.type));
        const sorted = [...rows].sort((a, b) => a.at.getTime() - b.at.getTime() || a.id - b.id);
        return { rows: sorted.map(row => ({ payload: row.payload })), rowCount: sorted.length };
      }

      if (sql.startsWith('INSERT INTO')) {
        const [id, userId, conversationId, channelId, data] = params as [string, string | null, string, string, string];
        const existing = sessions.findIndex(r => r.id === id);
        const row: MockRow = {
          id,
          user_id: userId ?? null,
          conversation_id: conversationId,
          channel_id: channelId,
          data,
          updated_at: new Date(),
        };
        if (existing >= 0) sessions[existing] = row;
        else sessions.push(row);
        return { rows: [], rowCount: 1 };
      }

      if (sql.startsWith('DELETE FROM') && sql.includes('WHERE id =')) {
        const [id] = params as [string];
        const before = sessions.length;
        const idx = sessions.findIndex(r => r.id === id);
        if (idx >= 0) sessions.splice(idx, 1);
        return { rows: [], rowCount: before - sessions.length };
      }

      if (sql.startsWith('DELETE FROM') && sql.includes('updated_at <')) {
        const [cutoff] = params as [Date];
        const before = sessions.length;
        for (let i = sessions.length - 1; i >= 0; i--) {
          if (sessions[i]!.updated_at < cutoff) sessions.splice(i, 1);
        }
        return { rows: [], rowCount: before - sessions.length };
      }

      return { rows: [], rowCount: 0 };
    },
  };
}

runSessionStoreContract(() =>
  new PostgresSessionStore({ client: createMockPgClient() as never }),
);

describe('PostgresSessionStore audit entries', () => {
  test('appendAuditEntry + listAuditEntries persist chronological filtered entries', async () => {
    const store = new PostgresSessionStore({ client: createMockPgClient() as never });
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
