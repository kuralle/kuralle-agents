import { describe, expect, it } from 'bun:test';
import type { ChoiceOption } from '@kuralle-agents/core';
import {
  InMemoryWindowStore,
  OutboundPipeline,
  isTagCapable,
  windowGuard,
} from '@kuralle-agents/messaging';
import type {
  InboundMessage,
  OutboundRequest,
  OutboundSink,
  WindowState,
} from '@kuralle-agents/messaging';
import type { TemplateInfo, WhatsAppClient } from '@kuralle-agents/messaging-meta/whatsapp';

import {
  closedWindowRecovery,
  interactiveRenderer,
  renderChoices,
  whatsappPolicy,
  resolveInboundWhatsApp,
} from '../src/index.js';
import {
  createSmartSendStrategist,
  type AuditSink,
  type ConversionAudit,
  type TemplateCatalog,
  type TemplateDescriptor,
  type TemplateSelector,
} from '../src/strategist.js';

const closedWindow: WindowState = { open: false, expiresAt: new Date('2020-01-01') };
const openWindow: WindowState = { open: true, expiresAt: new Date('2099-01-01') };

const approvedOnly: TemplateDescriptor[] = [
  {
    name: 'order_reminder',
    language: 'en',
    category: 'utility',
    status: 'APPROVED',
    quality: 'GREEN',
    params: [{ key: 'item', required: true }],
  },
];

function mockCatalog(approved: TemplateDescriptor[]): TemplateCatalog {
  return {
    approved: async () => approved,
    validateParams: () => ({ ok: true }),
  };
}

function mockSelector(
  behavior: TemplateSelector['select'] | 'throw',
): TemplateSelector & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async select(input) {
      calls += 1;
      if (behavior === 'throw') throw new Error('selector failed');
      return behavior(input);
    },
  };
}

function mockAudit(): AuditSink & { records: ConversionAudit[] } {
  const records: ConversionAudit[] = [];
  return {
    records,
    record(a) {
      records.push(a);
    },
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

function mockWhatsAppClient(templates: TemplateInfo[] = [orderReminderTemplate()]): WhatsAppClient {
  return {
    templates: {
      list: async () => templates,
    },
  } as unknown as WhatsAppClient;
}

function makeSendResult(threadId = 'thread-1') {
  return { messageId: 'msg-out', threadId, timestamp: new Date() };
}

function closedTextRequest(text = 'still want pizza?', window = closedWindow): OutboundRequest {
  return {
    threadId: 'thread-1',
    platform: 'whatsapp',
    payload: { kind: 'text', text },
    meta: {
      window,
      parts: [],
      sessionId: 'sess-1',
    },
  };
}

function createTemplateSink(): OutboundSink & {
  sendTextCalls: number;
  sendTemplateCalls: Array<[string, { name: string }]>;
  sendTextWithTagCalls: Array<[string, string, string]>;
} {
  let sendTextCalls = 0;
  const sendTemplateCalls: Array<[string, { name: string }]> = [];
  const sendTextWithTagCalls: Array<[string, string, string]> = [];
  return {
    get sendTextCalls() {
      return sendTextCalls;
    },
    sendTemplateCalls,
    sendTextWithTagCalls,
    sendText: async (to) => {
      sendTextCalls++;
      return makeSendResult(to);
    },
    sendTextWithTag: async (to, text, tag) => {
      sendTextWithTagCalls.push([to, text, tag]);
      return makeSendResult(to);
    },
    sendInteractive: async (to) => makeSendResult(to),
    sendMedia: async (to) => makeSendResult(to),
    sendTemplate: async (to, t) => {
      sendTemplateCalls.push([to, { name: t.name }]);
      return makeSendResult(to);
    },
  };
}

function waPolicyFromStrategist(
  windowStore: InMemoryWindowStore,
  strategistOpts: {
    catalog: TemplateCatalog;
    selector: TemplateSelector;
    audit: AuditSink;
  },
) {
  const strategist = createSmartSendStrategist(strategistOpts);
  return {
    channel: 'whatsapp' as const,
    hasWindow: true,
    async isWindowOpen(threadId: string) {
      return (await windowStore.get(threadId)).open;
    },
    closedWindow: { kind: 'template' as const, strategist },
    consentRequired: true,
    renderInteractive: renderChoices,
    resolveInbound: resolveInboundWhatsApp,
  };
}

describe('whatsappPolicy', () => {
  it('returns ChannelPolicy with whatsapp channel and template closedWindow', () => {
    const store = new InMemoryWindowStore();
    const policy = whatsappPolicy({
      client: mockWhatsAppClient(),
      selector: mockSelector(async () => null),
      windowStore: store,
      wabaId: 'waba-1',
    });

    expect(policy.channel).toBe('whatsapp');
    expect(policy.hasWindow).toBe(true);
    expect(policy.consentRequired).toBe(true);
    expect(policy.closedWindow.kind).toBe('template');
    expect(policy.closedWindow.kind === 'template' && policy.closedWindow.strategist).toBeTruthy();
    expect(typeof policy.isWindowOpen).toBe('function');
    expect(typeof policy.renderInteractive).toBe('function');
    expect(typeof policy.resolveInbound).toBe('function');
  });
});

describe('closedWindowRecovery', () => {
  it('converts closed-window text to template via strategist', async () => {
    const store = new InMemoryWindowStore();
    const policy = waPolicyFromStrategist(store, {
      catalog: mockCatalog(approvedOnly),
      selector: mockSelector(async () => ({
        name: 'order_reminder',
        language: 'en',
        params: { item: 'pizza' },
      })),
      audit: mockAudit(),
    });
    const sink = createTemplateSink();
    const pipeline = new OutboundPipeline(
      [closedWindowRecovery([policy]), windowGuard],
      sink,
    );

    const outcome = await pipeline.send(closedTextRequest());

    expect(outcome.kind).toBe('sent');
    expect(sink.sendTextCalls).toBe(0);
    expect(sink.sendTemplateCalls).toEqual([['thread-1', { name: 'order_reminder' }]]);
  });

  it('passes open-window text without template conversion', async () => {
    const store = new InMemoryWindowStore();
    await store.recordInbound('thread-1', new Date());
    const policy = waPolicyFromStrategist(store, {
      catalog: mockCatalog(approvedOnly),
      selector: mockSelector(async () => ({
        name: 'order_reminder',
        language: 'en',
        params: { item: 'x' },
      })),
      audit: mockAudit(),
    });
    const sink = createTemplateSink();
    const pipeline = new OutboundPipeline(
      [closedWindowRecovery([policy]), windowGuard],
      sink,
    );

    const outcome = await pipeline.send(
      closedTextRequest('hello', { open: true, expiresAt: new Date('2099-01-01') }),
    );

    expect(outcome.kind).toBe('sent');
    expect(sink.sendTextCalls).toBe(1);
    expect(sink.sendTemplateCalls).toHaveLength(0);
  });

  it('passes closed-window non-text to windowGuard which defers', async () => {
    const store = new InMemoryWindowStore();
    const policy = waPolicyFromStrategist(store, {
      catalog: mockCatalog(approvedOnly),
      selector: mockSelector(async () => null),
      audit: mockAudit(),
    });
    const sink = createTemplateSink();
    const pipeline = new OutboundPipeline(
      [closedWindowRecovery([policy]), windowGuard],
      sink,
    );

    const outcome = await pipeline.send({
      ...closedTextRequest(),
      payload: {
        kind: 'interactive',
        interactive: {
          type: 'buttons',
          body: 'pick',
          action: { type: 'buttons', buttons: [{ id: 'a', title: 'A' }] },
        },
      },
    });

    expect(outcome).toEqual({ kind: 'deferred', reason: 'window-closed' });
    expect(sink.sendTextCalls).toBe(0);
    expect(sink.sendTemplateCalls).toHaveLength(0);
  });
});

describe('tagged_text_seam', () => {
  it('isTagCapable detects sendTextWithTag on sink', () => {
    const sink = createTemplateSink();
    expect(isTagCapable(sink)).toBe(true);
    const plain: OutboundSink = {
      sendText: async () => makeSendResult(),
      sendInteractive: async () => makeSendResult(),
      sendMedia: async () => makeSendResult(),
    };
    expect(isTagCapable(plain)).toBe(false);
  });

  it('pipeline uses sendTextWithTag for tagged text when capable', async () => {
    const sink = createTemplateSink();
    const pipeline = new OutboundPipeline([windowGuard], sink);
    const outcome = await pipeline.send({
      threadId: 'thread-1',
      platform: 'instagram',
      payload: { kind: 'text', text: 'hi', tag: 'HUMAN_AGENT' },
      meta: { window: openWindow, parts: [], sessionId: 'sess-1' },
    });

    expect(outcome.kind).toBe('sent');
    expect(sink.sendTextCalls).toBe(0);
    expect(sink.sendTextWithTagCalls).toEqual([['thread-1', 'hi', 'HUMAN_AGENT']]);
  });

  it('untagged text still uses sendText', async () => {
    const sink = createTemplateSink();
    const pipeline = new OutboundPipeline([windowGuard], sink);
    await pipeline.send({
      threadId: 'thread-1',
      platform: 'whatsapp',
      payload: { kind: 'text', text: 'plain' },
      meta: { window: openWindow, parts: [], sessionId: 'sess-1' },
    });

    expect(sink.sendTextCalls).toBe(1);
    expect(sink.sendTextWithTagCalls).toHaveLength(0);
  });
});

describe('whatsapp_policy_unchanged_behavior', () => {
  it('closed-window text → template; open-window text; over-limit render; inbound by id', async () => {
    const store = new InMemoryWindowStore();
    const selector = mockSelector(async () => ({
      name: 'order_reminder',
      language: 'en',
      params: { item: 'pizza' },
    }));
    const waPolicy = whatsappPolicy({
      client: mockWhatsAppClient(),
      selector,
      windowStore: store,
      wabaId: 'waba-1',
      audit: mockAudit(),
    });

    const sink = createTemplateSink();
    const pipeline = new OutboundPipeline(
      [closedWindowRecovery([waPolicy]), windowGuard],
      sink,
    );

    const closedOutcome = await pipeline.send(closedTextRequest('order update'));
    expect(closedOutcome.kind).toBe('sent');
    expect(sink.sendTemplateCalls).toEqual([['thread-1', { name: 'order_reminder' }]]);

    await store.recordInbound('thread-1', new Date());
    const openOutcome = await pipeline.send(
      closedTextRequest('hello', { open: true, expiresAt: new Date('2099-01-01') }),
    );
    expect(openOutcome.kind).toBe('sent');
    expect(sink.sendTextCalls).toBeGreaterThanOrEqual(1);

    const overLimit: ChoiceOption[] = Array.from({ length: 11 }, (_, i) => ({
      id: `id-${i}`,
      label: `Opt ${i}`,
    }));
    expect(() => waPolicy.renderInteractive(overLimit, 'Too many')).toThrow(
      /too many options/,
    );

    const mw = interactiveRenderer([waPolicy]);
    let interactivePayload: OutboundRequest | undefined;
    await mw.send(
      {
        threadId: 'thread-1',
        platform: 'whatsapp',
        payload: { kind: 'text', text: 'x' },
        meta: {
          window: openWindow,
          parts: [
            {
              type: 'interactive',
              nodeId: 'pick',
              options: [
                { id: 'a', label: 'Alpha' },
                { id: 'b', label: 'Bravo' },
              ],
              prompt: 'Pick',
            },
          ],
          sessionId: 'sess-1',
        },
      },
      async (req) => {
        interactivePayload = req;
        return { kind: 'sent', result: makeSendResult() };
      },
    );
    expect(interactivePayload?.payload.kind).toBe('interactive');
    if (interactivePayload?.payload.kind === 'interactive') {
      expect(interactivePayload.payload.interactive.type).toBe('buttons');
    }

    const inbound: InboundMessage = {
      id: 'm-1',
      platform: 'whatsapp',
      threadId: '+1',
      customerId: 'u-1',
      from: { id: 'u-1' },
      timestamp: new Date(),
      type: 'interactive',
      interactive: { type: 'button_reply', id: 'a', title: 'Alpha' },
    };
    expect(waPolicy.resolveInbound(inbound)).toEqual({
      input: 'a',
      selection: { id: 'a' },
    });
  });
});
