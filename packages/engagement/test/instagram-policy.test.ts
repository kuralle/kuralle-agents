import { describe, expect, it } from 'bun:test';
import type { ChoiceOption } from '@kuralle-agents/core';
import {
  InMemoryWindowStore,
  OutboundPipeline,
  windowGuard,
} from '@kuralle-agents/messaging';
import type { InboundMessage, OutboundRequest, OutboundSink } from '@kuralle-agents/messaging';
import type { InstagramClient } from '@kuralle-agents/messaging-meta/instagram';

import {
  closedWindowRecovery,
  instagramPolicy,
  renderChoices,
  renderInstagramInteractive,
  resolveInboundInstagram,
  resolveInboundWhatsApp,
} from '../src/index.js';

const closedWindow = { open: false, expiresAt: new Date('2020-01-01') };
const openWindow = { open: true, expiresAt: new Date('2099-01-01') };

function mockInstagramClient(): InstagramClient {
  return {} as InstagramClient;
}

function makeSendResult(threadId = 'thread-ig-1') {
  return { messageId: 'msg-out', threadId, timestamp: new Date() };
}

function closedIgTextRequest(text = 'follow up', window = closedWindow): OutboundRequest {
  return {
    threadId: 'thread-ig-1',
    platform: 'instagram',
    payload: { kind: 'text', text },
    meta: {
      window,
      parts: [],
      sessionId: 'sess-1',
    },
  };
}

function createIgSink(): OutboundSink & {
  sendTextCalls: number;
  sendTextWithTagCalls: Array<[string, string, string]>;
  sendInteractiveCalls: number;
} {
  let sendTextCalls = 0;
  let sendInteractiveCalls = 0;
  const sendTextWithTagCalls: Array<[string, string, string]> = [];
  return {
    get sendTextCalls() {
      return sendTextCalls;
    },
    get sendInteractiveCalls() {
      return sendInteractiveCalls;
    },
    sendTextWithTagCalls,
    sendText: async (to) => {
      sendTextCalls++;
      return makeSendResult(to);
    },
    sendTextWithTag: async (to, text, tag) => {
      sendTextWithTagCalls.push([to, text, tag]);
      return makeSendResult(to);
    },
    sendInteractive: async (to) => {
      sendInteractiveCalls++;
      return makeSendResult(to);
    },
    sendMedia: async (to) => makeSendResult(to),
  };
}

function choiceOptions(count: number, labelPrefix = 'Opt'): ChoiceOption[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `id-${i + 1}`,
    label: `${labelPrefix} ${i + 1}`,
  }));
}

describe('instagramPolicy', () => {
  it('returns ChannelPolicy with instagram channel and HUMAN_AGENT message-tag closedWindow', () => {
    const store = new InMemoryWindowStore();
    const policy = instagramPolicy({ client: mockInstagramClient(), windowStore: store });

    expect(policy.channel).toBe('instagram');
    expect(policy.hasWindow).toBe(true);
    expect(policy.consentRequired).toBe(true);
    expect(policy.closedWindow).toEqual({ kind: 'message-tag', tag: 'HUMAN_AGENT' });
    expect(typeof policy.isWindowOpen).toBe('function');
    expect(typeof policy.renderInteractive).toBe('function');
    expect(typeof policy.resolveInbound).toBe('function');
  });
});

describe('instagram_closed_window_tags_or_defers', () => {
  it('tags closed-window text with HUMAN_AGENT; defers interactive and media', async () => {
    const store = new InMemoryWindowStore();
    const policy = instagramPolicy({ client: mockInstagramClient(), windowStore: store });
    const sink = createIgSink();
    const pipeline = new OutboundPipeline(
      [closedWindowRecovery([policy]), windowGuard],
      sink,
    );

    const textOutcome = await pipeline.send(closedIgTextRequest('agent reply'));
    expect(textOutcome.kind).toBe('sent');
    expect(sink.sendTextCalls).toBe(0);
    expect(sink.sendTextWithTagCalls).toEqual([
      ['thread-ig-1', 'agent reply', 'HUMAN_AGENT'],
    ]);

    sink.sendTextWithTagCalls.length = 0;

    const interactiveOutcome = await pipeline.send({
      ...closedIgTextRequest(),
      payload: {
        kind: 'interactive',
        interactive: {
          type: 'buttons',
          body: 'pick',
          action: { type: 'buttons', buttons: [{ id: 'a', title: 'A' }] },
        },
      },
    });
    expect(interactiveOutcome).toEqual({
      kind: 'deferred',
      reason: 'window-closed-tag-text-only',
    });
    expect(sink.sendTextWithTagCalls).toHaveLength(0);
    expect(sink.sendInteractiveCalls).toBe(0);

    const mediaOutcome = await pipeline.send({
      ...closedIgTextRequest(),
      payload: {
        kind: 'media',
        media: { type: 'image', data: 'https://example.com/x.jpg', mimeType: 'image/jpeg' },
      },
    });
    expect(mediaOutcome).toEqual({
      kind: 'deferred',
      reason: 'window-closed-tag-text-only',
    });
    expect(sink.sendInteractiveCalls).toBe(0);
  });

  it('passes open-window text without tag', async () => {
    const store = new InMemoryWindowStore();
    await store.recordInbound('thread-ig-1', new Date());
    const policy = instagramPolicy({ client: mockInstagramClient(), windowStore: store });
    const sink = createIgSink();
    const pipeline = new OutboundPipeline(
      [closedWindowRecovery([policy]), windowGuard],
      sink,
    );

    const outcome = await pipeline.send(
      closedIgTextRequest('hello', { open: true, expiresAt: new Date('2099-01-01') }),
    );

    expect(outcome.kind).toBe('sent');
    expect(sink.sendTextCalls).toBe(1);
    expect(sink.sendTextWithTagCalls).toHaveLength(0);
  });
});

describe('renderInstagramInteractive', () => {
  it('renders ≤3 options as buttons', () => {
    const msg = renderInstagramInteractive(choiceOptions(3), 'Pick one');
    expect(msg.type).toBe('buttons');
    if (msg.action.type !== 'buttons') throw new Error('expected buttons');
    expect(msg.action.buttons).toHaveLength(3);
    expect(msg.action.buttons.map((b) => b.id)).toEqual(['id-1', 'id-2', 'id-3']);
  });

  it('renders 4–10 options as list (carousel via client)', () => {
    const msg = renderInstagramInteractive(choiceOptions(6), 'Choose');
    expect(msg.type).toBe('list');
    if (msg.action.type !== 'list') throw new Error('expected list');
    expect(msg.action.sections[0]!.rows).toHaveLength(6);
  });

  it('throws when more than 10 options', () => {
    expect(() => renderInstagramInteractive(choiceOptions(11), 'Too many')).toThrow(
      /too many options \(max 10 carousel elements\)/,
    );
  });

  it('throws when a title exceeds 20 characters', () => {
    const options: ChoiceOption[] = [
      { id: 'a', label: 'A'.repeat(21) },
      { id: 'b', label: 'OK' },
    ];
    expect(() => renderInstagramInteractive(options, 'Pick')).toThrow(/exceeds 20 characters/);
  });

  it('rejects flow options', () => {
    const options: ChoiceOption[] = [
      {
        id: 'flow-1',
        label: 'Start',
        flow: { flowId: 'f1', cta: 'Go' },
      },
    ];
    expect(() => renderInstagramInteractive(options, 'Flow')).toThrow(
      /not supported on Instagram/,
    );
  });
});

describe('resolveInboundInstagram', () => {
  it('maps interactive id and postback payload to selection id', () => {
    const interactive: InboundMessage = {
      id: 'm-1',
      platform: 'instagram',
      threadId: 't-1',
      customerId: 'u-1',
      from: { id: 'u-1' },
      timestamp: new Date(),
      type: 'interactive',
      interactive: { type: 'button_reply', id: 'opt-a', title: 'Alpha' },
    };
    expect(resolveInboundInstagram(interactive)).toEqual({
      input: 'opt-a',
      selection: { id: 'opt-a' },
    });

    const postback: InboundMessage = {
      id: 'm-2',
      platform: 'instagram',
      threadId: 't-1',
      customerId: 'u-1',
      from: { id: 'u-1' },
      timestamp: new Date(),
      type: 'interactive',
      button: { payload: 'opt-b', text: 'Bravo' },
    };
    expect(resolveInboundInstagram(postback)).toEqual({
      input: 'opt-b',
      selection: { id: 'opt-b' },
    });
  });

  it('falls back to plain text', () => {
    const text: InboundMessage = {
      id: 'm-3',
      platform: 'instagram',
      threadId: 't-1',
      customerId: 'u-1',
      from: { id: 'u-1' },
      timestamp: new Date(),
      type: 'text',
      text: 'hello',
    };
    expect(resolveInboundInstagram(text)).toEqual({ input: 'hello', selection: undefined });
  });
});

describe('same_bot_across_channels', () => {
  it('preserves option ids across WA and IG renderers and inbound resolution', () => {
    const options: ChoiceOption[] = [
      { id: 'alpha', label: 'Alpha' },
      { id: 'bravo', label: 'Bravo' },
      { id: 'charlie', label: 'Charlie' },
      { id: 'delta', label: 'Delta' },
      { id: 'echo', label: 'Echo' },
    ];
    const prompt = 'Pick one';

    const waMsg = renderChoices(options, prompt);
    const igMsg = renderInstagramInteractive(options, prompt);

    expect(waMsg.type).toBe('list');
    expect(igMsg.type).toBe('list');
    if (waMsg.action.type !== 'list' || igMsg.action.type !== 'list') {
      throw new Error('expected list actions');
    }
    const waIds = waMsg.action.sections[0]!.rows.map((r) => r.id);
    const igIds = igMsg.action.sections[0]!.rows.map((r) => r.id);
    expect(waIds).toEqual(igIds);
    expect(waIds).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo']);

    const waInbound: InboundMessage = {
      id: 'm-wa',
      platform: 'whatsapp',
      threadId: 't-wa',
      customerId: 'u-1',
      from: { id: 'u-1' },
      timestamp: new Date(),
      type: 'interactive',
      interactive: { type: 'button_reply', id: 'delta', title: 'Delta' },
    };
    const igInbound: InboundMessage = {
      id: 'm-ig',
      platform: 'instagram',
      threadId: 't-ig',
      customerId: 'u-1',
      from: { id: 'u-1' },
      timestamp: new Date(),
      type: 'interactive',
      button: { payload: 'delta', text: 'Delta' },
    };

    expect(resolveInboundWhatsApp(waInbound)).toEqual(resolveInboundInstagram(igInbound));
    expect(resolveInboundInstagram(igInbound)).toEqual({
      input: 'delta',
      selection: { id: 'delta' },
    });
  });

  it('uses buttons shape for ≤3 options on both channels with same ids', () => {
    const options: ChoiceOption[] = [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ];
    const waMsg = renderChoices(options, 'Confirm?');
    const igMsg = renderInstagramInteractive(options, 'Confirm?');
    expect(waMsg.type).toBe('buttons');
    expect(igMsg.type).toBe('buttons');
    if (waMsg.action.type !== 'buttons' || igMsg.action.type !== 'buttons') {
      throw new Error('expected buttons');
    }
    expect(waMsg.action.buttons.map((b) => b.id)).toEqual(
      igMsg.action.buttons.map((b) => b.id),
    );
  });
});
