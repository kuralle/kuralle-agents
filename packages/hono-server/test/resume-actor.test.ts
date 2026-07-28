import { describe, expect, it } from 'bun:test';
import type { Context } from 'hono';
import type { RuntimeLike, SignalActor, StreamPart } from '@kuralle-agents/core';
import { createKuralleChatRouter } from '../src/index.js';

// The audit log is only worth having if it names the human who decided. The server must
// take that identity from its own auth context and never from the request body — a client
// that can name its own actor can approve as anyone.
describe('resume signal actor', () => {
  function stubRuntime(seen: { delivery?: unknown }): RuntimeLike {
    return {
      run(opts: { signalDelivery?: unknown }) {
        seen.delivery = opts.signalDelivery;
        const events = (async function* (): AsyncGenerator<StreamPart> {
          yield { type: 'done', channel: 'client', payload: {} } as unknown as StreamPart;
        })();
        return {
          events,
          then: (resolve: (v: unknown) => unknown) => Promise.resolve({}).then(resolve),
        } as never;
      },
    } as unknown as RuntimeLike;
  }

  const body = {
    sessionId: 's1',
    signal: {
      signalId: 'sig-1',
      requestId: 'req-1',
      name: '__approval',
      decision: 'approve',
      actor: { id: 'attacker-claimed-admin', type: 'user' },
    },
  };

  async function post(app: ReturnType<typeof createKuralleChatRouter>): Promise<void> {
    const res = await app.request('/api/chat/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    await res.text();
  }

  it('ignores an actor supplied in the request body', async () => {
    const seen: { delivery?: unknown } = {};
    await post(createKuralleChatRouter({ runtime: stubRuntime(seen) }));

    const actor = (seen.delivery as { actor: SignalActor }).actor;
    expect(actor.id).not.toBe('attacker-claimed-admin');
    expect(actor).toEqual({ id: 'hono-resume', type: 'service' });
  });

  it('attributes the decision to the identity the host resolves', async () => {
    const seen: { delivery?: unknown } = {};
    await post(
      createKuralleChatRouter({
        runtime: stubRuntime(seen),
        resolveSignalActor: (_c: Context) => ({ id: 'manager-42', type: 'user' as const }),
      }),
    );

    expect((seen.delivery as { actor: SignalActor }).actor).toEqual({
      id: 'manager-42',
      type: 'user',
    });
  });
});
