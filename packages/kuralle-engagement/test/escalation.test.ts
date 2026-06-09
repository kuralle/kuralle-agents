import { describe, expect, it } from 'bun:test';
import type { OwnershipStore } from '@kuralle-agents/messaging';
import type { EscalationRequest } from '@kuralle-agents/core';
import { createOwnershipEscalationHandler, resolveEscalation } from '../src/escalation.js';

function fakeOwnership() {
  const owners = new Map<string, 'bot' | 'human'>();
  const store: OwnershipStore = {
    async owner(threadId) {
      return owners.get(threadId) ?? 'bot';
    },
    async claim(threadId, by) {
      owners.set(threadId, by);
    },
    async release(threadId) {
      owners.delete(threadId);
    },
  };
  return { store, owners };
}

function request(overrides: Partial<EscalationRequest> = {}): EscalationRequest {
  return {
    sessionId: 'whatsapp:123:9477',
    userId: '9477',
    agentId: 'main',
    reason: 'user asked for a human',
    state: {},
    recentMessages: [{ role: 'user', content: 'human please' }],
    at: new Date().toISOString(),
    ...overrides,
  };
}

describe('createOwnershipEscalationHandler', () => {
  it('claims thread ownership for the human and queues by default', async () => {
    const { store, owners } = fakeOwnership();
    const handler = createOwnershipEscalationHandler({ ownership: store });

    const outcome = await handler(request());

    expect(owners.get('whatsapp:123:9477')).toBe('human');
    expect(outcome).toEqual({ status: 'queued', queueId: 'whatsapp:123:9477' });
  });

  it('uses notify outcome and custom threadId mapping', async () => {
    const { store, owners } = fakeOwnership();
    const notified: EscalationRequest[] = [];
    const handler = createOwnershipEscalationHandler({
      ownership: store,
      threadIdFor: (req) => `thread-${req.userId}`,
      notify: async (req) => {
        notified.push(req);
        return { status: 'connected', operatorId: 'op-7' };
      },
    });

    const outcome = await handler(request());

    expect(owners.get('thread-9477')).toBe('human');
    expect(notified).toHaveLength(1);
    expect(outcome).toEqual({ status: 'connected', operatorId: 'op-7' });
  });
});

describe('resolveEscalation', () => {
  it('releases ownership and resumes the runtime with the resolution', async () => {
    const { store, owners } = fakeOwnership();
    owners.set('sess-1', 'human');
    const resumed: Array<{ sessionId: string; summary?: string }> = [];

    await resolveEscalation({
      runtime: {
        async resumeFromEscalation(sessionId, opts) {
          resumed.push({ sessionId, summary: opts?.resolutionSummary });
        },
      },
      ownership: store,
      sessionId: 'sess-1',
      resolutionSummary: 'Refunded order #42.',
    });

    expect(owners.has('sess-1')).toBe(false);
    expect(resumed).toEqual([{ sessionId: 'sess-1', summary: 'Refunded order #42.' }]);
  });
});
