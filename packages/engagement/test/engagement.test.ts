import { describe, it, expect } from 'bun:test';
import type { ChoiceOption } from '@kuralle-agents/core';
import { MemoryStore } from '@kuralle-agents/core';
import { createMockRuntime } from '@kuralle-agents/core/testing';
import type { HarnessStreamPart } from '@kuralle-agents/core';
import {
  createMessagingRouter,
  InMemoryWindowStore,
  InboundResolverChain,
} from '@kuralle-agents/messaging';
import type {
  InboundMessage,
  InteractiveMessage,
  PlatformClient,
  SendResult,
} from '@kuralle-agents/messaging';
import type { TemplateInfo, WhatsAppClient } from '@kuralle-agents/messaging-meta/whatsapp';
import type { InstagramClient } from '@kuralle-agents/messaging-meta/instagram';

import {
  engagement,
  policyInboundResolver,
  sessionConsentStore,
  sessionOwnershipStore,
  whatsappPolicy,
  instagramPolicy,
  resolveInboundWhatsApp,
  resolveInboundInstagram,
} from '../src/index.js';
import type { ChannelPolicy } from '../src/policy.js';
import type { TemplateSelector } from '../src/strategist.js';

function makeSendResult(threadId = 'thread-1'): SendResult {
  return { messageId: 'mock', threadId, timestamp: new Date() };
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

function orderReminderTemplate(): TemplateInfo {
  return {
    id: 'tpl-order',
    name: 'order_reminder',
    language: 'en',
    status: 'APPROVED',
    category: 'UTILITY',
    components: [{ type: 'BODY', text: 'Your {{item}} is ready' }],
    quality: 'GREEN',
  };
}

function mockWhatsAppClient(): WhatsAppClient {
  return {
    templates: { list: async () => [orderReminderTemplate()] },
  } as unknown as WhatsAppClient;
}

function mockInstagramClient(): InstagramClient {
  return {} as unknown as InstagramClient;
}

const mockSelector: TemplateSelector = {
  async select() {
    return { name: 'order_reminder', language: 'en', params: { item: 'pizza' } };
  },
};

function stubPolicy(
  channel: string,
  resolveInbound: ChannelPolicy['resolveInbound'],
): ChannelPolicy {
  return {
    channel,
    hasWindow: false,
    async isWindowOpen() {
      return true;
    },
    closedWindow: { kind: 'none' },
    consentRequired: false,
    renderInteractive: (_options: ChoiceOption[], prompt: string): InteractiveMessage => ({
      type: 'buttons',
      body: prompt,
      action: { type: 'buttons', buttons: [{ id: '1', title: 'A' }] },
    }),
    resolveInbound,
  };
}

async function* textStream(text: string): AsyncGenerator<HarnessStreamPart> {
  yield { type: 'text-delta', id: 't', delta: text };
}

describe('engagement_composes_bridge', () => {
  it('bridge.outbound order and router constructs without throwing', () => {
    const windowStore = new InMemoryWindowStore();
    const sessionStore = new MemoryStore();
    const consent = sessionConsentStore(sessionStore, { defaultOptedIn: true });
    const ownership = sessionOwnershipStore(sessionStore);
    const waPolicy = whatsappPolicy({
      client: mockWhatsAppClient(),
      selector: mockSelector,
      windowStore,
      wabaId: 'waba-1',
    });

    const { bridge } = engagement({
      policies: [waPolicy],
      consent,
      ownership,
      windowStore,
    });

    expect(bridge.outbound!.map((m) => m.name)).toEqual([
      'consent-gate',
      'ownership-gate',
      'closed-window-recovery',
      'interactive-renderer',
    ]);
    expect(bridge.outbound!.some((m) => m.name === 'window-guard')).toBe(false);
    expect(bridge.inputResolver).toHaveLength(1);
    expect(bridge.inputResolver![0]!.name).toBe('policy-inbound');
    expect(bridge.windowStore).toBe(windowStore);
    expect(bridge.consent).toBe(consent);
    expect(bridge.ownership).toBe(ownership);

    const runtime = createMockRuntime(textStream('hi'));
    const platform = createMockPlatform();
    expect(() =>
      createMessagingRouter({
        runtime,
        platforms: { whatsapp: platform },
        ...bridge,
      }),
    ).not.toThrow();
  });

  it('omits gates when consent and ownership stores are not provided', () => {
    const windowStore = new InMemoryWindowStore();
    const waPolicy = whatsappPolicy({
      client: mockWhatsAppClient(),
      selector: mockSelector,
      windowStore,
      wabaId: 'waba-1',
    });

    const { bridge } = engagement({ policies: [waPolicy], windowStore });

    expect(bridge.outbound!.map((m) => m.name)).toEqual([
      'closed-window-recovery',
      'interactive-renderer',
    ]);
  });
});

describe('engagement_inbound_resolver_dispatches_by_platform', () => {
  it('dispatches whatsapp and instagram inbounds and resolves free text', async () => {
    const windowStore = new InMemoryWindowStore();
    const waPolicy = whatsappPolicy({
      client: mockWhatsAppClient(),
      selector: mockSelector,
      windowStore,
      wabaId: 'waba-1',
    });
    const igPolicy = instagramPolicy({
      client: mockInstagramClient(),
      windowStore,
    });

    const resolver = policyInboundResolver([waPolicy, igPolicy]);
    const chain = new InboundResolverChain([resolver]);

    const waInteractive: InboundMessage = {
      id: 'wa-1',
      platform: 'whatsapp',
      threadId: '+1',
      customerId: 'u-1',
      from: { id: 'u-1' },
      timestamp: new Date(),
      type: 'interactive',
      interactive: { type: 'button_reply', id: 'btn-wa', title: 'Go' },
    };
    expect(await chain.resolve(waInteractive)).toEqual(resolveInboundWhatsApp(waInteractive));

    const igInteractive: InboundMessage = {
      id: 'ig-1',
      platform: 'instagram',
      threadId: 'ig-thread',
      customerId: 'ig-user',
      from: { id: 'ig-user' },
      timestamp: new Date(),
      type: 'interactive',
      interactive: { type: 'button_reply', id: 'btn-ig', title: 'Go' },
    };
    expect(await chain.resolve(igInteractive)).toEqual(resolveInboundInstagram(igInteractive));

    const waText: InboundMessage = {
      id: 'wa-text',
      platform: 'whatsapp',
      threadId: '+1',
      customerId: 'u-1',
      from: { id: 'u-1' },
      timestamp: new Date(),
      type: 'text',
      text: 'hello there',
    };
    expect(await chain.resolve(waText)).toEqual({
      input: 'hello there',
      selection: undefined,
    });
  });

  it('returns undefined for unknown platform so chain can fall through', async () => {
    const wa = stubPolicy('whatsapp', (m) => ({ input: `wa:${m.text ?? ''}` }));
    const resolver = policyInboundResolver([wa]);
    const unknown: InboundMessage = {
      id: 'x-1',
      platform: 'telegram',
      threadId: 't',
      customerId: 'c',
      from: { id: 'c' },
      timestamp: new Date(),
      type: 'text',
      text: 'hi',
    };
    expect(await resolver.tryResolve(unknown)).toBeUndefined();
  });
});

describe('engagement broadcasts', () => {
  it('throws when broadcast pipeline is not configured', async () => {
    const windowStore = new InMemoryWindowStore();
    const waPolicy = whatsappPolicy({
      client: mockWhatsAppClient(),
      selector: mockSelector,
      windowStore,
      wabaId: 'waba-1',
    });
    const { broadcasts } = engagement({ policies: [waPolicy], windowStore });
    await expect(
      broadcasts.send({
        id: 'c1',
        template: { name: 'promo', language: 'en' },
        recipients: [{ customerId: 'a', threadId: 't-a' }],
      }),
    ).rejects.toThrow(/no broadcast pipeline configured/);
  });
});
