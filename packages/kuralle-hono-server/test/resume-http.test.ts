import { describe, expect, it } from 'bun:test';
import type { RuntimeLike } from '@kuralle-agents/core';
import { createMockTurnHandle } from '@kuralle-agents/core/testing';
import { createKuralleChatRouter } from '../src/index.ts';

describe('POST /api/chat/resume', () => {
  it('forwards signalDelivery to runtime.run and streams the resumed turn', async () => {
    let captured: { sessionId?: string; signalDelivery?: unknown } | undefined;
    const runtime = {
      run: (opts: { sessionId?: string }) => {
        captured = opts;
        return createMockTurnHandle(
          (async function* () {
            yield { type: 'text-delta', text: 'resumed' } as never;
            yield { type: 'done', sessionId: opts.sessionId } as never;
          })(),
        );
      },
      stream: () => createMockTurnHandle((async function* () {})()),
      getSession: async () => null,
      getSessionStore: () => ({
        save: async () => {},
        get: async () => null,
        delete: async () => {},
        list: async () => [],
      }),
      abortSession: () => {},
      deleteSession: async () => {},
      replayAuditLog: async () => [],
    } as unknown as RuntimeLike;

    const app = createKuralleChatRouter({ runtime, streamFilter: 'all' });
    const res = await app.request('/api/chat/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 's1',
        signal: { signalId: 'sig1', name: '__approval', payload: { approved: true, by: 'mgr' } },
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('resumed');

    expect(captured?.sessionId).toBe('s1');
    expect(captured?.signalDelivery).toEqual({
      signalId: 'sig1',
      name: '__approval',
      payload: { approved: true, by: 'mgr' },
    });
  });

  it('400s when sessionId or signal is missing', async () => {
    const runtime = {
      run: () => createMockTurnHandle((async function* () {})()),
      getSession: async () => null,
    } as unknown as RuntimeLike;
    const app = createKuralleChatRouter({ runtime });

    const res = await app.request('/api/chat/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1' }),
    });
    expect(res.status).toBe(400);
  });
});
