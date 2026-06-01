import { describe, it, expect } from 'bun:test';
import { createMessagingRouter } from '../src/adapter/createMessagingRouter.js';
import type { ConsentStore } from '../src/adapter/consent-store.js';
import type { InboundMessage, PlatformClient, SendResult } from '../src/types.js';
import type { HarnessStreamPart } from '@kuralle-agents/core';
import { createMockRuntime } from '@kuralle-agents/core/testing';

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'msg-1',
    platform: 'whatsapp',
    threadId: 'thread-consent-1',
    customerId: 'cust-stop-1',
    from: { id: 'cust-stop-1', name: 'Test User' },
    timestamp: new Date(),
    type: 'text',
    text: 'STOP',
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

async function* textStream(text: string): AsyncGenerator<HarnessStreamPart> {
  yield { type: 'text-delta', text };
}

function trackingConsent(): ConsentStore & { optedOut: string[]; runOptOut: boolean } {
  const optedOut: string[] = [];
  let optedIn = true;
  return {
    optedOut,
    get runOptOut() {
      return optedOut.length > 0;
    },
    isOptedIn: async (customerId) => !optedOut.includes(customerId) && optedIn,
    optOut: async (customerId) => {
      optedOut.push(customerId);
      optedIn = false;
    },
    optIn: async () => {
      optedIn = true;
    },
  };
}

describe('consent STOP inbound', () => {
  it('stop_inbound_opts_out_without_running_flow', async () => {
    const platform = createMockPlatform();
    const consent = trackingConsent();
    let runCount = 0;

    const runtime = createMockRuntime(textStream('should not run'), {
      onRun: () => {
        runCount++;
      },
    });

    createMessagingRouter({
      runtime,
      platforms: { mock: platform },
      consent,
    });

    const handler = platform._messageHandlers[0]!;
    await handler(makeMessage({ text: '  stop  ' }), {});
    expect(consent.optedOut).toEqual(['cust-stop-1']);
    expect(runCount).toBe(0);

    await handler(makeMessage({ id: 'msg-2', text: 'hello' }), {});
    expect(runCount).toBe(1);
  });
});
