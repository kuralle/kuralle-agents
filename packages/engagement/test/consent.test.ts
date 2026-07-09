import { describe, it, expect } from 'bun:test';
import { MemoryStore } from '@kuralle-agents/core';
import { OutboundPipeline, windowGuard } from '@kuralle-agents/messaging';
import type { OutboundRequest, OutboundSink } from '@kuralle-agents/messaging';
import { sessionConsentStore, consentGate } from '../src/consent.js';

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
      userId: 'customer-1',
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

describe('sessionConsentStore', () => {
  it('defaults to opted-out when unset', async () => {
    const store = sessionConsentStore(new MemoryStore());
    expect(await store.isOptedIn('new-customer')).toBe(false);
  });

  it('respects defaultOptedIn constructor option', async () => {
    const store = sessionConsentStore(new MemoryStore(), { defaultOptedIn: true });
    expect(await store.isOptedIn('new-customer')).toBe(true);
  });

  it('optIn and optOut persist per customerId', async () => {
    const store = sessionConsentStore(new MemoryStore());
    await store.optIn('c1');
    expect(await store.isOptedIn('c1')).toBe(true);
    await store.optOut('c1');
    expect(await store.isOptedIn('c1')).toBe(false);
    expect(await store.isOptedIn('c2')).toBe(false);
  });
});

describe('consentGate', () => {
  it('not_opted_in_blocks_send', async () => {
    const sessionStore = new MemoryStore();
    const consent = sessionConsentStore(sessionStore);
    const sink = createRecordingSink();
    const pipeline = new OutboundPipeline([consentGate(consent), windowGuard], sink);

    const blocked = await pipeline.send(makeRequest({ meta: { ...makeRequest().meta, userId: 'cust-a' } }));
    expect(blocked).toEqual({ kind: 'deferred', reason: 'not-opted-in' });
    expect(sink.sendTextCalls).toBe(0);

    await consent.optIn('cust-a');
    const sent = await pipeline.send(makeRequest({ meta: { ...makeRequest().meta, userId: 'cust-a' } }));
    expect(sent.kind).toBe('sent');
    expect(sink.sendTextCalls).toBe(1);
  });

  it('stop_opts_out_and_halts_drip', async () => {
    const sessionStore = new MemoryStore();
    const consent = sessionConsentStore(sessionStore);
    await consent.optIn('cust-stop');
    expect(await consent.isOptedIn('cust-stop')).toBe(true);

    await consent.optOut('cust-stop');
    expect(await consent.isOptedIn('cust-stop')).toBe(false);

    const sink = createRecordingSink();
    const pipeline = new OutboundPipeline([consentGate(consent), windowGuard], sink);
    const outcome = await pipeline.send(
      makeRequest({ meta: { ...makeRequest().meta, userId: 'cust-stop' } }),
    );
    expect(outcome).toEqual({ kind: 'deferred', reason: 'not-opted-in' });
    expect(sink.sendTextCalls).toBe(0);
  });
});
