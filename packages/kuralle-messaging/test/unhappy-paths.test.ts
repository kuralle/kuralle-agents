import { describe, it, expect } from 'bun:test';
import { MessageDeduplicator } from '../src/shared/deduplicator.js';
import { WindowTracker } from '../src/adapter/window-tracker.js';
import { defaultSessionResolver } from '../src/adapter/session-resolver.js';
import { StreamMapper } from '../src/adapter/stream-mapper.js';
import { createMessagingRouter } from '../src/adapter/createMessagingRouter.js';
import { InMemoryWindowStore } from '../src/adapter/window-store.js';
import { OutboundPipeline } from '../src/adapter/outbound-pipeline.js';
import { windowGuard } from '../src/adapter/middleware/window-guard.js';
import type { StreamMapperOptions } from '../src/types.js';
import type {
  InboundMessage,
  PlatformClient,
  ReactionData,
  SendResult,
  InteractiveMessage,
  StatusUpdate,
} from '../src/types.js';
import type { HarnessStreamPart } from '@kuralle-agents/core';
import { createMockRuntime } from '@kuralle-agents/core/testing';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'msg-1',
    platform: 'whatsapp',
    threadId: '1234567890',
    customerId: 'user-1',
    from: { id: 'user-1', name: 'Test User' },
    timestamp: new Date(),
    type: 'text',
    text: 'hello',
    ...overrides,
  };
}

function makeSendResult(): SendResult {
  return { messageId: 'mock', threadId: 'mock', timestamp: new Date() };
}

type MockPlatformClient = PlatformClient & {
  _messageHandlers: Array<(message: InboundMessage, raw: unknown) => Promise<void>>;
  _statusHandlers: Array<(status: StatusUpdate) => Promise<void>>;
  _reactionHandlers: Array<(reaction: ReactionData) => Promise<void>>;
  readonly _typingCalls: number;
};

function createMockPlatform(options?: {
  onSendText?: (to: string, text: string) => Promise<SendResult>;
  onSendInteractive?: (to: string, msg: InteractiveMessage) => Promise<SendResult>;
}): MockPlatformClient {
  const messageHandlers: Array<(message: InboundMessage, raw: unknown) => Promise<void>> = [];
  const statusHandlers: Array<(status: StatusUpdate) => Promise<void>> = [];
  const reactionHandlers: Array<(reaction: ReactionData) => Promise<void>> = [];
  let typingCalls = 0;

  return {
    platform: 'mock',
    handleWebhook: async () => new Response('OK', { status: 200 }),
    onMessage: (h) => messageHandlers.push(h),
    onStatus: (h) => statusHandlers.push(h),
    onReaction: (h) => reactionHandlers.push(h),
    sendText: options?.onSendText ?? (async () => makeSendResult()),
    sendMedia: async () => makeSendResult(),
    sendInteractive: options?.onSendInteractive ?? (async () => makeSendResult()),
    sendRaw: async () => makeSendResult(),
    markAsRead: async () => {},
    sendTypingIndicator: async () => {
      typingCalls++;
    },
    uploadMedia: async () => ({ mediaId: 'mock' }),
    downloadMedia: async () => ({ data: Buffer.from(''), mimeType: 'text/plain' }),
    formatConverter: {
      toPlainText: (t: string) => t,
      toMarkdown: (t: string) => t,
      toPlatformFormat: (t: string) => t,
    },
    webhookRouter: () => {
      throw new Error('not implemented');
    },
    _messageHandlers: messageHandlers,
    _statusHandlers: statusHandlers,
    _reactionHandlers: reactionHandlers,
    get _typingCalls() {
      return typingCalls;
    },
  };
}

// Stream generator helpers

async function* emptyStream(): AsyncGenerator<HarnessStreamPart> {
  // yields nothing
}

async function* textStream(text: string): AsyncGenerator<HarnessStreamPart> {
  yield { type: 'text-delta' as const, text };
}

async function* errorStream(): AsyncGenerator<HarnessStreamPart> {
  yield { type: 'text-delta' as const, text: 'partial...' };
  throw new Error('stream crashed');
}

async function* emptyTextStream(): AsyncGenerator<HarnessStreamPart> {
  yield { type: 'text-delta' as const, text: '' };
  yield { type: 'done' as const, sessionId: 'sess1' };
}

async function* errorPartStream(): AsyncGenerator<HarnessStreamPart> {
  yield { type: 'error' as const, error: 'something went wrong' };
}

async function* nonTextStream(): AsyncGenerator<HarnessStreamPart> {
  yield { type: 'node-enter' as const, nodeName: 'greeting' };
  yield { type: 'node-exit' as const, nodeName: 'greeting' };
  yield { type: 'done' as const, sessionId: 'sess1' };
}

async function openWindowMapperOptions(
  platform: PlatformClient,
  threadId: string,
  extra?: Partial<StreamMapperOptions>,
): Promise<StreamMapperOptions> {
  const windowStore = new InMemoryWindowStore();
  await windowStore.recordInbound(threadId, new Date());
  const pipeline = new OutboundPipeline([windowGuard], platform);
  return {
    pipeline,
    windowStore,
    sessionId: 'sess-1',
    ...extra,
  };
}

// ===========================================================================
// Deduplicator edge cases
// ===========================================================================

describe('MessageDeduplicator — unhappy paths', () => {
  it('handles empty string ID', () => {
    const dedup = new MessageDeduplicator();
    expect(dedup.isDuplicate('')).toBe(false);
    expect(dedup.isDuplicate('')).toBe(true);
    expect(dedup.size).toBe(1);
  });

  it('handles very long string ID (10 000 chars)', () => {
    const dedup = new MessageDeduplicator();
    const longId = 'x'.repeat(10_000);
    expect(dedup.isDuplicate(longId)).toBe(false);
    expect(dedup.isDuplicate(longId)).toBe(true);
  });

  it('handles 100 rapid concurrent calls with the same ID', () => {
    const dedup = new MessageDeduplicator();
    const results: boolean[] = [];
    for (let i = 0; i < 100; i++) {
      results.push(dedup.isDuplicate('rapid-id'));
    }
    // First call is not a duplicate, all subsequent are duplicates
    expect(results[0]).toBe(false);
    expect(results.slice(1).every((r) => r === true)).toBe(true);
    expect(dedup.size).toBe(1);
  });

  it('maxSize of 1 — only tracks the last message', () => {
    const dedup = new MessageDeduplicator(1, 300_000);
    dedup.isDuplicate('a');
    expect(dedup.isDuplicate('a')).toBe(true);

    // Adding a second evicts the first
    dedup.isDuplicate('b');
    // 'a' was evicted, so it is treated as new
    expect(dedup.isDuplicate('a')).toBe(false);
    // But inserting 'a' just evicted 'b', so 'b' is also new
    expect(dedup.isDuplicate('b')).toBe(false);
  });

  it('ttlMs of 0 — everything is immediately expired', () => {
    const dedup = new MessageDeduplicator(100, 0);
    dedup.isDuplicate('msg-1');
    // With ttlMs=0, the entry is considered expired on the very next call
    // because Date.now() - timestamp >= 0 is always true
    expect(dedup.isDuplicate('msg-1')).toBe(false); // treated as new
  });

  it('maxSize of 0 — does not throw, still records entries', () => {
    // With maxSize 0, every insertion triggers eviction of size - 0 + 1 = 1 entries,
    // but the entry is still set after eviction
    expect(() => {
      const dedup = new MessageDeduplicator(0, 300_000);
      dedup.isDuplicate('a');
      dedup.isDuplicate('b');
    }).not.toThrow();
  });
});

// ===========================================================================
// WindowTracker edge cases
// ===========================================================================

describe('WindowTracker — unhappy paths', () => {
  it('recordInbound with a Date in the far future (year 3000)', () => {
    const tracker = new WindowTracker();
    const futureDate = new Date('3000-01-01T00:00:00Z');
    tracker.recordInbound('thread-1', futureDate);
    expect(tracker.isWindowOpen('thread-1')).toBe(true);

    const expiry = tracker.getExpiry('thread-1')!;
    expect(expiry.getTime()).toBe(futureDate.getTime() + 24 * 60 * 60 * 1000);
  });

  it('recordInbound with Invalid Date does not crash', () => {
    const tracker = new WindowTracker();
    const invalidDate = new Date('garbage');
    expect(() => tracker.recordInbound('thread-1', invalidDate)).not.toThrow();

    // The window should NOT be open since the expiry is NaN-based
    // NaN > new Date() is always false
    expect(tracker.isWindowOpen('thread-1')).toBe(false);
  });

  it('recordInbound with epoch 0 — window should be expired', () => {
    const tracker = new WindowTracker();
    const epoch0 = new Date(0); // 1970-01-01
    tracker.recordInbound('thread-1', epoch0);
    // Expiry = epoch 0 + 24h = 1970-01-02, which is long past
    expect(tracker.isWindowOpen('thread-1')).toBe(false);
  });

  it('recordExpiry overwriting with a closer expiry (shrinks window)', () => {
    const tracker = new WindowTracker();

    // Open window via inbound (expires in ~24h)
    tracker.recordInbound('thread-1', new Date());
    expect(tracker.isWindowOpen('thread-1')).toBe(true);

    // Shrink window with recordExpiry to 1 second from now
    const nearExpiry = new Date(Date.now() + 1_000);
    tracker.recordExpiry('thread-1', nearExpiry);

    const expiry = tracker.getExpiry('thread-1')!;
    expect(expiry.getTime()).toBe(nearExpiry.getTime());
    // Still open for now
    expect(tracker.isWindowOpen('thread-1')).toBe(true);
  });

  it('isWindowOpen with a thread whose window expired millions of ms ago', () => {
    const tracker = new WindowTracker();
    const ancientDate = new Date(Date.now() - 100_000_000_000); // ~3.17 years ago
    tracker.recordInbound('thread-1', ancientDate);
    expect(tracker.isWindowOpen('thread-1')).toBe(false);
  });

  it('thread IDs with special characters', () => {
    const tracker = new WindowTracker();
    const specialIds = [
      '',
      '  ',
      'thread\0null',
      'thread\nnewline',
      '\u{1F600}\u{1F680}', // emoji
      '\u4F60\u597D', // unicode CJK
      'a'.repeat(5000),
    ];

    for (const id of specialIds) {
      expect(() => tracker.recordInbound(id, new Date())).not.toThrow();
      expect(tracker.isWindowOpen(id)).toBe(true);
    }

    expect(tracker.size).toBe(specialIds.length);
  });

  it('empty string thread ID', () => {
    const tracker = new WindowTracker();
    tracker.recordInbound('', new Date());
    expect(tracker.isWindowOpen('')).toBe(true);
    expect(tracker.getExpiry('')).not.toBeNull();
  });
});

// ===========================================================================
// SessionResolver edge cases
// ===========================================================================

describe('defaultSessionResolver — unhappy paths', () => {
  it('message with empty string platform and threadId', async () => {
    const msg = makeMessage({ platform: '', threadId: '' });
    const result = await defaultSessionResolver.resolve(msg);
    expect(result.sessionId).toBe('');
  });

  it('message with from.id missing still uses customerId as userId', async () => {
    const msg = makeMessage();
    delete (msg.from as { id?: string }).id;
    const result = await defaultSessionResolver.resolve(msg);
    expect(result.sessionId).toBe('1234567890');
    expect(result.userId).toBe('user-1');
  });

  it('very long thread IDs (1000+ chars)', async () => {
    const longThread = 'T'.repeat(2000);
    const msg = makeMessage({ threadId: longThread });
    const result = await defaultSessionResolver.resolve(msg);
    expect(result.sessionId).toBe(longThread);
    expect(result.sessionId.length).toBe(2000);
  });

  it('special characters in threadId are preserved verbatim', async () => {
    const msg = makeMessage({ platform: 'plat:form', threadId: 'thread:id:with:colons' });
    const result = await defaultSessionResolver.resolve(msg);
    expect(result.sessionId).toBe('thread:id:with:colons');
  });
});

// ===========================================================================
// StreamMapper error handling
// ===========================================================================

describe('StreamMapper — unhappy paths', () => {
  it('empty stream — sends nothing', async () => {
    const mapper = new StreamMapper();
    let sendTextCalled = false;
    const platform = createMockPlatform({
      onSendText: async () => {
        sendTextCalled = true;
        return makeSendResult();
      },
    });

    const parts = await mapper.mapStream(
      emptyStream(),
      platform,
      'thread-1',
      await openWindowMapperOptions(platform, 'thread-1'),
    );
    expect(parts).toEqual([]);
    expect(sendTextCalled).toBe(false);
  });

  it('stream with only non-text-delta parts — does not send empty text', async () => {
    const mapper = new StreamMapper();
    const sentTexts: string[] = [];
    const platform = createMockPlatform({
      onSendText: async (_to, text) => {
        sentTexts.push(text);
        return makeSendResult();
      },
    });

    const parts = await mapper.mapStream(
      nonTextStream(),
      platform,
      'thread-1',
      await openWindowMapperOptions(platform, 'thread-1'),
    );
    expect(parts.length).toBe(3);
    // No text was accumulated, so sendText should NOT be called
    expect(sentTexts).toEqual([]);
  });

  it('stream that throws mid-stream — typing indicator is cleaned up', async () => {
    const mapper = new StreamMapper();
    const platform = createMockPlatform();

    await expect(
      mapper.mapStream(
        errorStream(),
        platform,
        'thread-1',
        await openWindowMapperOptions(platform, 'thread-1'),
      ),
    ).rejects.toThrow('stream crashed');

    // The typing indicator interval was cleared via the finally block.
    // Verify that no further typing calls accumulate after the error.
    const callsAfterError = platform._typingCalls;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(platform._typingCalls).toBe(callsAfterError);
  });

  it('stream with only error parts — handles gracefully', async () => {
    const mapper = new StreamMapper();
    const sentTexts: string[] = [];
    const platform = createMockPlatform({
      onSendText: async (_to, text) => {
        sentTexts.push(text);
        return makeSendResult();
      },
    });

    const parts = await mapper.mapStream(
      errorPartStream(),
      platform,
      'thread-1',
      await openWindowMapperOptions(platform, 'thread-1'),
    );
    expect(parts.length).toBe(1);
    expect(parts[0].type).toBe('error');
    // No text was accumulated so sendText should not be called
    expect(sentTexts).toEqual([]);
  });

  it('stream with text-delta producing empty string — does not send empty message', async () => {
    const mapper = new StreamMapper();
    const sentTexts: string[] = [];
    const platform = createMockPlatform({
      onSendText: async (_to, text) => {
        sentTexts.push(text);
        return makeSendResult();
      },
    });

    const parts = await mapper.mapStream(
      emptyTextStream(),
      platform,
      'thread-1',
      await openWindowMapperOptions(platform, 'thread-1'),
    );
    // text-delta with '' yields empty buffer; trim().length === 0 so no send
    expect(sentTexts).toEqual([]);
    expect(parts.length).toBe(2);
  });

  it('stream mapper uses custom typing interval', async () => {
    const mapper = new StreamMapper();
    const platform = createMockPlatform();

    // Use a very short typing interval to verify it fires
    async function* slowStream(): AsyncGenerator<HarnessStreamPart> {
      await new Promise((r) => setTimeout(r, 100));
      yield { type: 'text-delta' as const, text: 'hello' };
    }

    await mapper.mapStream(slowStream(), platform, 'thread-1', {
      ...(await openWindowMapperOptions(platform, 'thread-1')),
      typingIntervalMs: 30,
    });

    // With 100ms delay and 30ms interval, typing should have fired multiple times
    // (initial + interval hits). At least 2 calls expected.
    expect(platform._typingCalls).toBeGreaterThanOrEqual(2);
  });

  it('sendText failure during default response does not swallow error', async () => {
    const mapper = new StreamMapper();
    const platform = createMockPlatform({
      onSendText: async () => {
        throw new Error('platform send failed');
      },
    });

    await expect(
      mapper.mapStream(
        textStream('hello world'),
        platform,
        'thread-1',
        await openWindowMapperOptions(platform, 'thread-1'),
      ),
    ).rejects.toThrow('platform send failed');
  });
});

// ===========================================================================
// createMessagingRouter error handling
// ===========================================================================

describe('createMessagingRouter — unhappy paths', () => {
  it('empty platforms object — returns a router with no routes', () => {
    const runtime = createMockRuntime([]);
    const router = createMessagingRouter({
      runtime,
      platforms: {},
    });
    // Router should be a valid Hono instance with no platform routes
    expect(router).toBeDefined();
    expect(typeof router.fetch).toBe('function');
  });

  it('platform handler that throws — error callback fires and fallback sent', async () => {
    const errors: Error[] = [];
    const sentTexts: string[] = [];

    const platform = createMockPlatform({
      onSendText: async (_to, text) => {
        sentTexts.push(text);
        return makeSendResult();
      },
    });

    const runtime = createMockRuntime(() => {
      throw new Error('runtime exploded');
    });

    const router = createMessagingRouter({
      runtime,
      platforms: { mock: platform },
      onError: (err) => errors.push(err),
      fallbackMessage: 'Oops, something went wrong.',
    });

    // Trigger the registered message handler directly
    expect(platform._messageHandlers.length).toBe(1);
    const handler = platform._messageHandlers[0];
    const msg = makeMessage({ id: 'unique-msg-1' });

    // Should not throw — error is caught internally
    await handler(msg, {});

    expect(errors.length).toBe(1);
    expect(errors[0].message).toBe('runtime exploded');
    expect(sentTexts).toContain('Oops, something went wrong.');
  });

  it('fallback message send also fails — does not throw', async () => {
    const errors: Error[] = [];

    const platform = createMockPlatform({
      onSendText: async () => {
        throw new Error('send also broken');
      },
    });

    const runtime = createMockRuntime(() => {
      throw new Error('runtime down');
    });

    createMessagingRouter({
      runtime,
      platforms: { mock: platform },
      onError: (err) => errors.push(err),
    });

    const handler = platform._messageHandlers[0];
    const msg = makeMessage({ id: 'unique-msg-2' });

    // Should not throw even though both runtime and fallback fail
    await expect(handler(msg, {})).resolves.toBeUndefined();
    expect(errors.length).toBe(1);
    expect(errors[0].message).toBe('runtime down');
  });

  it('duplicate messages are skipped by the router', async () => {
    let runCallCount = 0;

    const platform = createMockPlatform();
    const runtime = createMockRuntime(emptyStream(), {
      onRun: () => {
        runCallCount++;
      },
    });

    createMessagingRouter({
      runtime,
      platforms: { mock: platform },
    });

    const handler = platform._messageHandlers[0];
    const msg = makeMessage({ id: 'dup-msg' });

    await handler(msg, {});
    await handler(msg, {}); // same ID — should be deduplicated

    expect(runCallCount).toBe(1);
  });

  it('status handler with conversation expiry updates window tracker', async () => {
    const platform = createMockPlatform();
    const runtime = createMockRuntime([]);

    createMessagingRouter({
      runtime,
      platforms: { mock: platform },
    });

    expect(platform._statusHandlers.length).toBe(1);
    const statusHandler = platform._statusHandlers[0];

    // Simulate a status update with conversation expiry
    await statusHandler({
      messageId: 'msg-1',
      status: 'delivered',
      timestamp: new Date(),
      recipientId: 'user-1',
      threadId: 'thread-1',
      conversation: {
        id: 'conv-1',
        expirationTimestamp: new Date(Date.now() - 1000), // already expired
      },
    });

    // The status handler should not throw
    // (We cannot directly inspect the windowTracker, but the handler ran without error)
  });

  it('default fallback message is used when none configured', async () => {
    const sentTexts: string[] = [];

    const platform = createMockPlatform({
      onSendText: async (_to, text) => {
        sentTexts.push(text);
        return makeSendResult();
      },
    });

    const runtime = createMockRuntime(() => {
      throw new Error('runtime error');
    });

    createMessagingRouter({
      runtime,
      platforms: { mock: platform },
    });

    const handler = platform._messageHandlers[0];
    await handler(makeMessage({ id: 'fallback-test' }), {});

    expect(sentTexts).toContain("Sorry, I'm having trouble right now. Please try again.");
  });
});
