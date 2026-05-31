import { describe, expect, it } from 'bun:test';
import type { ConversationAuditEntry, RuntimeLike } from '@kuralle-agents/core';
import { createMockRuntime } from '@kuralle-agents/core/testing';
import { createKuralleChatRouter } from '../src/index.ts';

describe('audit HTTP endpoint', () => {
  it('GET /api/sessions/:id/audit returns replayed entries with parsed filters', async () => {
    const calls: unknown[] = [];
    const runtime: RuntimeLike = {
      ...createMockRuntime([]),
      replayAuditLog: async (sessionId: string, opts: unknown) => {
        calls.push({ sessionId, opts });
        return [makeEntry()];
      },
    };
    const app = createKuralleChatRouter({ runtime });

    const response = await app.request('/api/sessions/session-1/audit?types=agent-start,tool-call&from=2026-01-01T00:00:00.000Z&to=2026-01-02T00:00:00.000Z');

    expect(response.status).toBe(200);
    const body = (await response.json()) as { total: number; entries: ConversationAuditEntry[] };
    expect(body.total).toBe(1);
    expect(body.entries).toEqual([makeEntry()]);
    expect(calls[0]).toMatchObject({
      sessionId: 'session-1',
      opts: {
        types: ['agent-start', 'tool-call'],
        from: new Date('2026-01-01T00:00:00.000Z'),
        to: new Date('2026-01-02T00:00:00.000Z'),
      },
    });
  });

  it('GET /api/sessions/:id/audit rejects invalid dates', async () => {
    const runtime: RuntimeLike = {
      ...createMockRuntime([]),
      replayAuditLog: async () => [],
    };
    const app = createKuralleChatRouter({ runtime });

    const response = await app.request('/api/sessions/session-1/audit?from=not-a-date');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'from must be a valid date' });
  });
});

function makeEntry(): ConversationAuditEntry {
  return {
    at: '2026-01-01T00:00:00.000Z',
    sessionId: 'session-1',
    conversationId: 'conversation-1',
    agentId: 'agent-1',
    type: 'agent-start',
  };
}
