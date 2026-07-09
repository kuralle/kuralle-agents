import { describe, expect, it } from 'bun:test';
import type { ConversationOutcome, RuntimeLike, Session } from '@kuralle-agents/core';
import { createMockSession, createMockTurnHandle } from '@kuralle-agents/core/testing';
import { createKuralleChatRouter } from '../src/index.ts';

describe('outcome HTTP endpoints', () => {
  it('POST /api/sessions/:id/outcome marks the outcome', async () => {
    const runtime = makeRuntime([makeSession('session-1')]);
    const app = createKuralleChatRouter({ runtime });

    const response = await app.request('/api/sessions/session-1/outcome', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'resolved', reason: 'Customer confirmed.' }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      outcome: { outcome: string; reason: string; markedBy: string };
    };
    expect(body.outcome).toMatchObject({
      outcome: 'resolved',
      reason: 'Customer confirmed.',
      markedBy: 'http',
    });
    expect(runtime.sessions.get('session-1')?.metadata?.outcome).toMatchObject({
      outcome: 'resolved',
      markedBy: 'http',
    });
  });

  it('GET /api/sessions/:id/outcome returns 404 when no outcome is set', async () => {
    const runtime = makeRuntime([makeSession('session-1')]);
    const app = createKuralleChatRouter({ runtime });

    const response = await app.request('/api/sessions/session-1/outcome');

    expect(response.status).toBe(404);
  });

  it('POST /api/sessions/:id/csat persists CSAT metadata', async () => {
    const runtime = makeRuntime([makeSession('session-1')]);
    const app = createKuralleChatRouter({ runtime });

    const response = await app.request('/api/sessions/session-1/csat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ score: 5, comment: 'Helpful.' }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      csat: { score: number; comment: string; collectedAt: string };
    };
    expect(typeof body.csat.collectedAt).toBe('string');
    expect(runtime.sessions.get('session-1')?.metadata?.csat).toMatchObject({
      score: 5,
      comment: 'Helpful.',
    });
  });
});

type OutcomeTestRuntime = RuntimeLike & {
  sessions: Map<string, Session>;
};

function makeRuntime(seed: Session[]): OutcomeTestRuntime {
  const sessions = new Map(seed.map((session) => [session.id, structuredClone(session)]));
  const base = {
    sessions,
    getSessionStore: () => ({
      save: async (session: Session) => {
        sessions.set(session.id, structuredClone(session));
      },
      get: async (id: string) => sessions.get(id) ?? null,
      delete: async (id: string) => {
        sessions.delete(id);
      },
      list: async () => [...sessions.values()],
    }),
    getSession: async (id: string) => sessions.get(id) ?? null,
    markOutcome: async (
      sessionId: string,
      outcome: ConversationOutcome,
      opts?: { reason?: string; markedBy?: 'tool' | 'hook' | 'http' | 'auto' },
    ) => {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`markOutcome: session not found: ${sessionId}`);
      session.metadata ??= makeMetadata(session.createdAt);
      session.metadata.outcome = {
        outcome,
        ...(opts?.reason ? { reason: opts.reason } : {}),
        markedAt: new Date().toISOString(),
        markedBy: opts?.markedBy ?? 'tool',
      };
      sessions.set(sessionId, structuredClone(session));
    },
    run: () => createMockTurnHandle((async function* () {})()),
    stream: () => createMockTurnHandle((async function* () {})()),
    abortSession: () => {},
    replayAuditLog: async () => [],
    deleteSession: async (id: string) => {
      sessions.delete(id);
    },
  };

  return base as OutcomeTestRuntime;
}

function makeSession(id: string): Session {
  const now = new Date();
  return createMockSession({
    id,
    conversationId: id,
    channelId: 'api',
    createdAt: now,
    updatedAt: now,
    currentAgent: 'agent-1',
    activeAgentId: 'agent-1',
    state: {},
    metadata: makeMetadata(now),
  });
}

function makeMetadata(createdAt: Date): NonNullable<Session['metadata']> {
  return {
    createdAt,
    lastActiveAt: createdAt,
    totalTokens: 0,
    totalSteps: 0,
    handoffHistory: [],
  };
}
