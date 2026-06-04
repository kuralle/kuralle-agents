import { describe, it, expect } from 'bun:test';
import { createMessagingRouter } from '../src/adapter/createMessagingRouter.js';
import type { OwnershipStore } from '../src/adapter/ownership-store.js';
import type { InboundMessage, PlatformClient, SendResult } from '../src/types.js';
import type { HarnessStreamPart } from '@kuralle-agents/core';
import { createMockRuntime, createMockSession } from '@kuralle-agents/core/testing';

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'msg-1',
    platform: 'whatsapp',
    threadId: 'thread-own-1',
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

type MockPlatform = PlatformClient & {
  _messageHandlers: Array<(message: InboundMessage, raw: unknown) => Promise<void>>;
};

function createMockPlatform(): MockPlatform {
  const messageHandlers: Array<(message: InboundMessage, raw: unknown) => Promise<void>> = [];
  return {
    platform: 'mock',
    handleWebhook: async () => new Response('OK', { status: 200 }),
    onMessage: (h) => messageHandlers.push(h),
    onStatus: () => {},
    onReaction: () => {},
    sendText: async () => makeSendResult(),
    sendMedia: async () => makeSendResult(),
    sendInteractive: async () => makeSendResult(),
    sendRaw: async () => makeSendResult(),
    markAsRead: async () => {},
    sendTypingIndicator: async () => {},
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
  };
}

function mutableOwnership(initial: 'bot' | 'human' = 'bot'): OwnershipStore {
  let current = initial;
  return {
    owner: async () => current,
    claim: async () => {
      current = 'human';
    },
    release: async () => {
      current = 'bot';
    },
  };
}

async function* textStream(text: string): AsyncGenerator<HarnessStreamPart> {
  yield { type: 'text-delta', id: 't', delta: text };
}

async function* humanHandoffStream(): AsyncGenerator<HarnessStreamPart> {
  yield { type: 'handoff', targetAgent: 'human', reason: 'escalate' };
  yield { type: 'done', sessionId: 'thread-own-1' };
}

describe('ownership inbound gate', () => {
  it('human_owned_inbound_does_not_run_flow', async () => {
    const platform = createMockPlatform();
    const ownership = mutableOwnership('human');
    const sessions = new Map([
      [
        'thread-own-1',
        createMockSession({ id: 'thread-own-1', messages: [{ role: 'assistant', content: 'prior' }] }),
      ],
    ]);
    let runCount = 0;

    const runtime = createMockRuntime(textStream('bot reply'), {
      sessions,
      onRun: () => {
        runCount++;
      },
    });

    createMessagingRouter({
      runtime,
      platforms: { mock: platform },
      ownership,
    });

    const handler = platform._messageHandlers[0]!;
    await handler(makeMessage({ id: 'owned-1', text: 'while human' }), {});

    expect(runCount).toBe(0);
    const session = await runtime.getSession('thread-own-1');
    expect(session?.messages.some((m) => m.role === 'user' && m.content === 'while human')).toBe(
      true,
    );

    await ownership.release('thread-own-1');
    await handler(makeMessage({ id: 'owned-2', text: 'after release' }), {});
    expect(runCount).toBe(1);
  });

  it('escalate_claims_ownership', async () => {
    const platform = createMockPlatform();
    const ownership = mutableOwnership('bot');
    const sessions = new Map<string, ReturnType<typeof createMockSession>>();

    const runtime = createMockRuntime(humanHandoffStream(), { sessions });

    createMessagingRouter({
      runtime,
      platforms: { mock: platform },
      ownership,
    });

    const handler = platform._messageHandlers[0]!;
    await handler(makeMessage({ id: 'escalate-1' }), {});

    expect(await ownership.owner('thread-own-1')).toBe('human');
  });
});
