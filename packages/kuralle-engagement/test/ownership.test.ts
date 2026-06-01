import { describe, it, expect } from 'bun:test';
import { MemoryStore } from '@kuralle-agents/core';
import { OutboundPipeline } from '@kuralle-agents/messaging';
import { windowGuard } from '@kuralle-agents/messaging';
import type { OutboundRequest, OutboundSink } from '@kuralle-agents/messaging';
import { sessionOwnershipStore, ownershipGate } from '../src/ownership.js';

function makeSendResult(threadId = 'thread-1') {
  return { messageId: 'msg-out', threadId, timestamp: new Date() };
}

function makeRequest(overrides: Partial<OutboundRequest> = {}): OutboundRequest {
  return {
    threadId: 'thread-1',
    platform: 'whatsapp',
    payload: { kind: 'text', text: 'hello' },
    meta: {
      window: { open: true, expiresAt: new Date(Date.now() + 86_400_000) },
      parts: [],
      sessionId: 'sess-1',
    },
    ...overrides,
  };
}

function createRecordingSink(): OutboundSink & { sendTextCalls: number } {
  let sendTextCalls = 0;
  return {
    get sendTextCalls() {
      return sendTextCalls;
    },
    sendText: async (to) => {
      sendTextCalls++;
      return makeSendResult(to);
    },
    sendInteractive: async (to) => makeSendResult(to),
    sendMedia: async (to) => makeSendResult(to),
  };
}

describe('sessionOwnershipStore', () => {
  it('defaults to bot when unset', async () => {
    const store = sessionOwnershipStore(new MemoryStore());
    expect(await store.owner('new-thread')).toBe('bot');
  });

  it('claim and release flip owner', async () => {
    const store = sessionOwnershipStore(new MemoryStore());
    await store.claim('t1', 'human');
    expect(await store.owner('t1')).toBe('human');
    await store.release('t1');
    expect(await store.owner('t1')).toBe('bot');
  });
});

describe('ownershipGate', () => {
  it('ownership_gate_suppresses', async () => {
    const sessionStore = new MemoryStore();
    const ownership = sessionOwnershipStore(sessionStore);
    await ownership.claim('thread-1', 'human');

    const sink = createRecordingSink();
    const pipeline = new OutboundPipeline([ownershipGate(ownership), windowGuard], sink);
    const outcome = await pipeline.send(makeRequest());

    expect(outcome).toEqual({ kind: 'suppressed', reason: 'human-owned' });
    expect(sink.sendTextCalls).toBe(0);
  });
});
