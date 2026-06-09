import { describe, expect, it } from 'bun:test';
import { createMessagingRouter } from '../src/adapter/createMessagingRouter.js';
import { InMemoryWindowStore } from '../src/adapter/window-store.js';
import type { InboundMessage, MessageHandler, PlatformClient } from '../src/types.js';
import type { MockRuntimeRunCall } from '@kuralle-agents/core/testing';
import { createMockRuntime } from '@kuralle-agents/core/testing';
import type { InputCoalescerTimer } from '../src/adapter/input-coalescer.js';

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: overrides.id ?? 'msg-1',
    platform: 'whatsapp',
    threadId: 'thread-1',
    customerId: 'user-1',
    from: { id: 'user-1', name: 'Test User' },
    timestamp: new Date(),
    type: overrides.type ?? 'text',
    text: overrides.text ?? 'hello',
    ...overrides,
  };
}

function createMockPlatform(): PlatformClient & {
  _handlers: MessageHandler[];
} {
  const handlers: MessageHandler[] = [];
  return {
    platform: 'mock',
    handleWebhook: async () => new Response('OK'),
    onMessage: (h) => {
      handlers.push(h);
    },
    onStatus: () => {},
    onReaction: () => {},
    sendText: async () => ({ messageId: 'out-1', threadId: 'thread-1', timestamp: new Date() }),
    sendMedia: async () => ({ messageId: 'out-2', threadId: 'thread-1', timestamp: new Date() }),
    sendInteractive: async () => ({ messageId: 'out-3', threadId: 'thread-1', timestamp: new Date() }),
    sendRaw: async () => ({ messageId: 'out-4', threadId: 'thread-1', timestamp: new Date() }),
    markAsRead: async () => {},
    sendTypingIndicator: async () => {},
    uploadMedia: async () => ({ mediaId: 'media-1' }),
    downloadMedia: async () => ({ data: Buffer.from('IMG'), mimeType: 'image/png' }),
    formatConverter: {
      toPlainText: (t: string) => t,
      toMarkdown: (t: string) => t,
      toPlatformFormat: (t: string) => t,
    },
    webhookRouter: () => {
      throw new Error('not implemented');
    },
    get _handlers() {
      return handlers;
    },
  };
}

function createTestTimer() {
  let now = 0;
  let nextId = 0;
  const scheduled: Array<{ fn: () => void; at: number; id: number }> = [];
  const cancelled = new Set<number>();

  const timer: InputCoalescerTimer = {
    set(fn, ms) {
      const id = nextId++;
      scheduled.push({ fn, at: now + ms, id });
      return id;
    },
    clear(handle) {
      cancelled.add(handle as number);
    },
  };

  function advance(ms: number) {
    now += ms;
    const due = scheduled
      .filter((s) => !cancelled.has(s.id) && s.at <= now)
      .sort((a, b) => a.at - b.at);
    for (const s of due) {
      cancelled.add(s.id);
      s.fn();
    }
  }

  async function flushPendingRuns() {
    await new Promise((r) => setTimeout(r, 0));
  }

  return { timer, advance, flushPendingRuns };
}

async function* emptyStream() {}

describe('createMessagingRouter inbound coalescing', () => {
  it('coalesces three rapid text webhooks into one runtime.run', async () => {
    const { timer, advance, flushPendingRuns } = createTestTimer();
    const runs: MockRuntimeRunCall[] = [];
    const platform = createMockPlatform();
    const runtime = createMockRuntime(emptyStream(), {
      onRun: (call) => runs.push(call),
    });

    createMessagingRouter({
      runtime,
      platforms: { mock: platform },
      windowStore: new InMemoryWindowStore(),
      inboundCoalescing: { debounceMs: 300, maxWaitMs: 5000, timer },
    });

    const handler = platform._handlers[0]!;
    await handler(makeMessage({ id: 'm1', text: 'hi' }), undefined);
    await handler(makeMessage({ id: 'm2', text: 'i want to order' }), undefined);
    await handler(makeMessage({ id: 'm3', text: 'the blue one' }), undefined);
    expect(runs).toHaveLength(0);

    advance(300);
    await flushPendingRuns();
    await flushPendingRuns();

    expect(runs).toHaveLength(1);
    expect(runs[0]?.input).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'text', text: 'i want to order' },
      { type: 'text', text: 'the blue one' },
    ]);
  });

  it('merges image then caption burst into [FilePart, TextPart]', async () => {
    const { timer, advance, flushPendingRuns } = createTestTimer();
    const runs: MockRuntimeRunCall[] = [];
    const platform = createMockPlatform();
    const runtime = createMockRuntime(emptyStream(), {
      onRun: (call) => runs.push(call),
    });

    createMessagingRouter({
      runtime,
      platforms: { mock: platform },
      windowStore: new InMemoryWindowStore(),
      inboundCoalescing: { debounceMs: 300, maxWaitMs: 5000, timer },
    });

    const handler = platform._handlers[0]!;
    await handler(
      makeMessage({
        id: 'img-1',
        type: 'image',
        text: undefined,
        media: { id: 'media-42', mimeType: 'image/png' },
      }),
      undefined,
    );
    await handler(makeMessage({ id: 'cap-1', type: 'text', text: 'can you read this?' }), undefined);
    advance(300);
    await flushPendingRuns();
    await flushPendingRuns();

    expect(runs).toHaveLength(1);
    const input = runs[0]?.input;
    expect(Array.isArray(input)).toBe(true);
    const parts = input as Array<{ type: string; text?: string; mediaType?: string }>;
    expect(parts[0]).toMatchObject({ type: 'file', mediaType: 'image/png' });
    expect(parts[1]).toEqual({ type: 'text', text: 'can you read this?' });
  });

  it('without inboundCoalescing config each message runs separately', async () => {
    const runs: MockRuntimeRunCall[] = [];
    const platform = createMockPlatform();
    const runtime = createMockRuntime(emptyStream(), {
      onRun: (call) => runs.push(call),
    });

    createMessagingRouter({
      runtime,
      platforms: { mock: platform },
      windowStore: new InMemoryWindowStore(),
    });

    const handler = platform._handlers[0]!;
    await handler(makeMessage({ id: 'a', text: 'one' }), undefined);
    await handler(makeMessage({ id: 'b', text: 'two' }), undefined);
    expect(runs).toHaveLength(2);
    expect(runs[0]?.input).toBe('one');
    expect(runs[1]?.input).toBe('two');
  });
});
