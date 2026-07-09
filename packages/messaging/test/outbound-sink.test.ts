import { describe, it, expect } from 'bun:test';
import type { PlatformClient, SendResult } from '../src/types.js';
import type { OutboundSink } from '../src/types/outbound.js';
import { isTemplateCapable } from '../src/types/outbound.js';

function makeSendResult(): SendResult {
  return { messageId: 'mock', threadId: 'mock', timestamp: new Date() };
}

function createMinimalPlatform(overrides?: {
  sendTemplate?: (to: string, t: { name: string; language: string }) => Promise<SendResult>;
}): PlatformClient {
  return {
    platform: 'mock',
    handleWebhook: async () => new Response('OK', { status: 200 }),
    onMessage: () => {},
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
    ...overrides,
  };
}

describe('OutboundSink', () => {
  it('assigns PlatformClient to OutboundSink', () => {
    const client = createMinimalPlatform();
    const _sink: OutboundSink = client;
    expect(_sink.sendText).toBeDefined();
  });
});

describe('capability_detection', () => {
  it('is true when sendTemplate is a function', () => {
    const client = createMinimalPlatform({
      sendTemplate: async () => makeSendResult(),
    });
    expect(isTemplateCapable(client)).toBe(true);
    if (isTemplateCapable(client)) {
      expect(typeof client.sendTemplate).toBe('function');
    }
  });

  it('is false when sendTemplate is absent', () => {
    const client = createMinimalPlatform();
    expect(isTemplateCapable(client)).toBe(false);
  });
});
