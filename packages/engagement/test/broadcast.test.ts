import { describe, it, expect } from 'bun:test';
import { MemoryStore } from '@kuralle-agents/core';
import {
  OutboundPipeline,
  windowGuard,
  createMessagingRouter,
} from '@kuralle-agents/messaging';
import type {
  ConsentStore,
  InboundMessage,
  OutboundSink,
  OutboundTemplate,
  PlatformClient,
  SendResult,
} from '@kuralle-agents/messaging';
import type { HarnessStreamPart } from '@kuralle-agents/core';
import { createMockRuntime } from '@kuralle-agents/core/testing';
import { sessionConsentStore } from '../src/consent.js';
import { createBroadcasts, type Campaign } from '../src/broadcast.js';
import { createInMemoryBroadcastLedger } from '../src/broadcast-ledger.js';

const approvedTemplate: OutboundTemplate = {
  name: 'promo_offer',
  language: 'en',
};

function makeSendResult(threadId = 'thread-1') {
  return { messageId: 'msg-out', threadId, timestamp: new Date() };
}

function createTemplateRecordingSink(): OutboundSink & {
  sendTemplateCalls: Array<[string, OutboundTemplate]>;
} {
  const sendTemplateCalls: Array<[string, OutboundTemplate]> = [];
  return {
    sendTemplateCalls,
    sendText: async (to) => makeSendResult(to),
    sendInteractive: async (to) => makeSendResult(to),
    sendMedia: async (to) => makeSendResult(to),
    sendTemplate: async (to, t) => {
      sendTemplateCalls.push([to, t]);
      return makeSendResult(to);
    },
  };
}

function mockConsent(optedIn: Record<string, boolean>): ConsentStore {
  return {
    isOptedIn: async (customerId) => optedIn[customerId] ?? false,
    optIn: async () => {},
    optOut: async () => {},
  };
}

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'camp-1',
    template: approvedTemplate,
    recipients: [
      { customerId: 'cust-a', threadId: 'thread-a' },
      { customerId: 'cust-b', threadId: 'thread-b' },
    ],
    ...overrides,
  };
}

describe('BroadcastLedger', () => {
  it('putIfAbsent returns true once then false for the same key', async () => {
    const ledger = createInMemoryBroadcastLedger();
    expect(await ledger.putIfAbsent('camp-1:cust-a')).toBe(true);
    expect(await ledger.putIfAbsent('camp-1:cust-a')).toBe(false);
    expect(await ledger.putIfAbsent('camp-1:cust-b')).toBe(true);
  });
});

describe('createBroadcasts', () => {
  it('sends template only to opted-in recipients', async () => {
    const sink = createTemplateRecordingSink();
    const pipeline = new OutboundPipeline([windowGuard], sink);
    const consent = mockConsent({ 'cust-a': true, 'cust-b': false });
    const ledger = createInMemoryBroadcastLedger();
    const broadcasts = createBroadcasts({
      pipeline,
      consent,
      ledger,
      platform: 'whatsapp',
    });

    const result = await broadcasts.send(makeCampaign());

    expect(result).toEqual({ sent: 1, skipped: 1 });
    expect(sink.sendTemplateCalls).toHaveLength(1);
    expect(sink.sendTemplateCalls[0]).toEqual(['thread-a', approvedTemplate]);
  });

  it('broadcast_ledger_idempotent_per_campaign_recipient', async () => {
    const sink = createTemplateRecordingSink();
    const pipeline = new OutboundPipeline([windowGuard], sink);
    const consent = mockConsent({ 'cust-a': true, 'cust-b': true, 'cust-c': false });
    const ledger = createInMemoryBroadcastLedger();
    const broadcasts = createBroadcasts({
      pipeline,
      consent,
      ledger,
      platform: 'whatsapp',
    });

    const campaign = makeCampaign({
      recipients: [
        { customerId: 'cust-a', threadId: 'thread-a' },
        { customerId: 'cust-b', threadId: 'thread-b' },
        { customerId: 'cust-c', threadId: 'thread-c' },
      ],
    });

    const first = await broadcasts.send(campaign);
    expect(first).toEqual({ sent: 2, skipped: 1 });
    expect(sink.sendTemplateCalls).toHaveLength(2);

    const second = await broadcasts.send(campaign);
    expect(second).toEqual({ sent: 0, skipped: 3 });
    expect(sink.sendTemplateCalls).toHaveLength(2);

    const freshLedger = createInMemoryBroadcastLedger();
    const freshBroadcasts = createBroadcasts({
      pipeline,
      consent,
      ledger: freshLedger,
      platform: 'whatsapp',
    });
    const third = await freshBroadcasts.send(campaign);
    expect(third).toEqual({ sent: 2, skipped: 1 });
    expect(sink.sendTemplateCalls).toHaveLength(4);
  });
});

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'msg-1',
    platform: 'whatsapp',
    threadId: 'thread-bcast-reply',
    customerId: 'cust-reply-1',
    from: { id: 'cust-reply-1', name: 'Recipient' },
    timestamp: new Date(),
    type: 'text',
    text: 'yes please',
    ...overrides,
  };
}

function makeSendResultInbound(): SendResult {
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
    sendText: async () => makeSendResultInbound(),
    sendMedia: async () => makeSendResultInbound(),
    sendInteractive: async () => makeSendResultInbound(),
    sendRaw: async () => makeSendResultInbound(),
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
  yield { type: 'text-delta', id: 't', delta: text };
}

describe('broadcast reply routing', () => {
  it('broadcast_reply_enters_flow', async () => {
    const platform = createMockPlatform();
    const sessionStore = new MemoryStore();
    const consent = sessionConsentStore(sessionStore);
    await consent.optIn('cust-reply-1');

    let runCount = 0;
    const runtime = createMockRuntime(textStream('flow reply'), {
      onRun: () => {
        runCount++;
      },
    });

    createMessagingRouter({
      runtime,
      platforms: { mock: platform },
      consent,
    });

    const sink = createTemplateRecordingSink();
    const pipeline = new OutboundPipeline([windowGuard], sink);
    const broadcasts = createBroadcasts({
      pipeline,
      consent,
      ledger: createInMemoryBroadcastLedger(),
      platform: 'mock',
    });

    await broadcasts.send({
      id: 'camp-reply',
      template: approvedTemplate,
      recipients: [{ customerId: 'cust-reply-1', threadId: 'thread-bcast-reply' }],
    });

    const handler = platform._messageHandlers[0]!;
    await handler(makeMessage(), {});

    expect(runCount).toBe(1);
  });
});
