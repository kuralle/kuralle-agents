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
        const sessionId = opts.sessionId;
        if (!sessionId) {
          throw new Error('resume requires sessionId');
        }
        return createMockTurnHandle(
          (async function* () {
            yield { channel: 'client', type: 'text-delta', payload: { id: 't', delta: 'resumed' } };
            yield { channel: 'client', type: 'done', payload: { sessionId } };
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
        signal: {
          signalId: 'sig1',
          requestId: 'req1',
          name: '__approval',
          decision: 'approve',
        },
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('resumed');

    expect(captured?.sessionId).toBe('s1');
    // The decision is bound to the request it authorises, and the actor comes from the
    // server rather than the body — a client that could name its own actor could approve
    // as anyone. No `resolveSignalActor` configured, so it is the service itself.
    expect(captured?.signalDelivery).toEqual({
      signalId: 'sig1',
      requestId: 'req1',
      name: '__approval',
      actor: { id: 'hono-resume', type: 'service' },
      decision: 'approve',
      reason: undefined,
      payload: undefined,
    });
  });

  it('400s when the signal has no requestId to bind the decision to', async () => {
    const runtime = {
      run: () => createMockTurnHandle((async function* () {})()),
      getSession: async () => null,
    } as unknown as RuntimeLike;
    const app = createKuralleChatRouter({ runtime });

    const res = await app.request('/api/chat/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 's1',
        signal: { signalId: 'sig1', name: '__approval', decision: 'approve' },
      }),
    });
    expect(res.status).toBe(400);
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
