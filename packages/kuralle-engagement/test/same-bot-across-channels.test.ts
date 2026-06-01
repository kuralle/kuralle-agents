import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import type { ChoiceOption, HarnessStreamPart } from '@kuralle-agents/core';
import {
  collect,
  decide,
  defineAgent,
  defineFlow,
  reply,
  createRuntime,
  MemoryStore,
} from '@kuralle-agents/core';
import type { LanguageModel } from 'ai';
import {
  InboundResolverChain,
  InMemoryWindowStore,
  OutboundPipeline,
  windowGuard,
} from '@kuralle-agents/messaging';
import type {
  InboundMessage,
  InteractiveMessage,
  OutboundRequest,
  OutboundSink,
} from '@kuralle-agents/messaging';
import type { InstagramClient } from '@kuralle-agents/messaging-meta/instagram';
import type { TemplateInfo, WhatsAppClient } from '@kuralle-agents/messaging-meta/whatsapp';

import {
  engagement,
  policyInboundResolver,
  renderChoices,
  renderInstagramInteractive,
  resolveInboundInstagram,
  resolveInboundWhatsApp,
  webPolicy,
  whatsappPolicy,
  instagramPolicy,
  withChoices,
} from '../src/index.js';
import type { TemplateSelector } from '../src/strategist.js';

const stubModel = {} as LanguageModel;
const closedWindow = { open: false, expiresAt: new Date('2020-01-01') };
const openWindow = { open: true, expiresAt: new Date('2099-01-01') };

const sharedChoices: ChoiceOption[] = [
  { id: 'alpha', label: 'Alpha' },
  { id: 'bravo', label: 'Bravo' },
  { id: 'charlie', label: 'Charlie' },
  { id: 'delta', label: 'Delta' },
  { id: 'echo', label: 'Echo' },
];

const twoChoices: ChoiceOption[] = [
  { id: 'yes', label: 'Yes' },
  { id: 'no', label: 'No' },
];

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

function makeSendResult(threadId: string) {
  return { messageId: 'msg-out', threadId, timestamp: new Date() };
}

function createRecordingSink(): OutboundSink & {
  sendTextCalls: number;
  sendTextWithTagCalls: Array<[string, string, string]>;
  sendTemplateCalls: Array<[string, { name: string }]>;
  sendInteractiveCalls: Array<{ threadId: string; interactive: InteractiveMessage }>;
} {
  let sendTextCalls = 0;
  const sendTextWithTagCalls: Array<[string, string, string]> = [];
  const sendTemplateCalls: Array<[string, { name: string }]> = [];
  const sendInteractiveCalls: Array<{ threadId: string; interactive: InteractiveMessage }> = [];
  return {
    get sendTextCalls() {
      return sendTextCalls;
    },
    sendTextWithTagCalls,
    sendTemplateCalls,
    sendInteractiveCalls,
    sendText: async (to) => {
      sendTextCalls++;
      return makeSendResult(to);
    },
    sendTextWithTag: async (to, text, tag) => {
      sendTextWithTagCalls.push([to, text, tag]);
      return makeSendResult(to);
    },
    sendTemplate: async (to, template) => {
      sendTemplateCalls.push([to, template]);
      return makeSendResult(to);
    },
    sendInteractive: async (to, interactive) => {
      sendInteractiveCalls.push({ threadId: to, interactive });
      return makeSendResult(to);
    },
    sendMedia: async (to) => makeSendResult(to),
  };
}

function interactivePart(options: ChoiceOption[], prompt = 'Pick one'): HarnessStreamPart {
  return { type: 'interactive', nodeId: 'pick', options, prompt };
}

function outboundWithInteractive(
  platform: string,
  threadId: string,
  part: HarnessStreamPart,
  window = openWindow,
): OutboundRequest {
  return {
    threadId,
    platform,
    payload: { kind: 'text', text: 'placeholder' },
    meta: { window, parts: [part], sessionId: 'sess-1' },
  };
}

function buildPolicies(windowStore: InMemoryWindowStore) {
  const wa = whatsappPolicy({
    client: mockWhatsAppClient(),
    selector: mockSelector,
    windowStore,
    wabaId: 'waba-1',
  });
  const web = webPolicy();
  const ig = instagramPolicy({ client: mockInstagramClient(), windowStore });
  return { wa, web, ig, all: [wa, web, ig] as const };
}

function engagementPipeline(
  windowStore: InMemoryWindowStore,
  sink: OutboundSink,
) {
  const { bridge } = engagement({ policies: [...buildPolicies(windowStore).all], windowStore });
  return {
    bridge,
    pipeline: new OutboundPipeline([...bridge.outbound!, windowGuard], sink),
  };
}

describe('same_bot_across_channels', () => {
  it('renders the same ChoiceOption ids per channel (WA list, IG carousel, web buttons)', async () => {
    const store = new InMemoryWindowStore();
    const { wa, web, ig } = buildPolicies(store);
    const part = interactivePart(sharedChoices);
    const { pipeline } = engagementPipeline(store, createRecordingSink());

    const waOutcome = await pipeline.send(outboundWithInteractive('whatsapp', 't-wa', part));
    const igOutcome = await pipeline.send(outboundWithInteractive('instagram', 't-ig', part));
    const webOutcome = await pipeline.send(outboundWithInteractive('web', 't-web', part));

    expect(waOutcome.kind).toBe('sent');
    expect(igOutcome.kind).toBe('sent');
    expect(webOutcome.kind).toBe('sent');

    const waRendered = wa.renderInteractive(sharedChoices, 'Pick one');
    const igRendered = ig.renderInteractive(sharedChoices, 'Pick one');
    const webRendered = web.renderInteractive(sharedChoices, 'Pick one');

    expect(waRendered.type).toBe('list');
    expect(igRendered.type).toBe('list');
    expect(webRendered.type).toBe('buttons');

    const waIds =
      waRendered.action.type === 'list'
        ? waRendered.action.sections[0]!.rows.map((r) => r.id)
        : [];
    const igIds =
      igRendered.action.type === 'list'
        ? igRendered.action.sections[0]!.rows.map((r) => r.id)
        : [];
    const webIds =
      webRendered.action.type === 'buttons'
        ? webRendered.action.buttons.map((b) => b.id)
        : [];

    expect(waIds).toEqual(igIds);
    expect(waIds).toEqual(webIds);
    expect(waIds).toEqual(sharedChoices.map((o) => o.id));
  });

  it('uses buttons for ≤3 options on WA, IG, and web with identical ids', () => {
    const { wa, web, ig } = buildPolicies(new InMemoryWindowStore());
    const waMsg = wa.renderInteractive(twoChoices, 'Confirm?');
    const igMsg = ig.renderInteractive(twoChoices, 'Confirm?');
    const webMsg = web.renderInteractive(twoChoices, 'Confirm?');

    expect(waMsg.type).toBe('buttons');
    expect(igMsg.type).toBe('buttons');
    expect(webMsg.type).toBe('buttons');

    if (
      waMsg.action.type !== 'buttons' ||
      igMsg.action.type !== 'buttons' ||
      webMsg.action.type !== 'buttons'
    ) {
      throw new Error('expected buttons');
    }
    expect(waMsg.action.buttons.map((b) => b.id)).toEqual(['yes', 'no']);
    expect(igMsg.action.buttons.map((b) => b.id)).toEqual(['yes', 'no']);
    expect(webMsg.action.buttons.map((b) => b.id)).toEqual(['yes', 'no']);
  });

  it('routes inbound selection by id identically on WA and IG via engagement resolver', async () => {
    const store = new InMemoryWindowStore();
    const { all } = buildPolicies(store);
    const chain = new InboundResolverChain([policyInboundResolver([...all])]);

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

    expect(await chain.resolve(waInbound)).toEqual(resolveInboundWhatsApp(waInbound));
    expect(await chain.resolve(igInbound)).toEqual(resolveInboundInstagram(igInbound));
    expect(await chain.resolve(waInbound)).toEqual(await chain.resolve(igInbound));
    expect(await chain.resolve(igInbound)).toEqual({
      input: 'delta',
      selection: { id: 'delta' },
    });
  });

  it('emits choices once from a single flow and renders per platform without bot branching', async () => {
    const endNode = reply({
      id: 'end',
      instructions: 'Done',
      next: () => ({ end: 'done' }),
    });
    const decideNode = withChoices(
      decide({
        id: 'pick',
        instructions: 'Pick one',
        schema: z.object({ choice: z.string() }),
        decide: () => endNode,
      }),
      [...sharedChoices],
    );
    const flow = defineFlow({
      name: 'same-bot',
      description: 'REQ-22 one bot',
      start: decideNode,
      nodes: [decideNode, endNode],
    });
    const agent = defineAgent({ id: 'omni', flows: [flow], model: stubModel });
    const sessionStore = new MemoryStore();
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: 'omni',
      sessionStore,
      defaultModel: stubModel,
      hostSelect: async () => ({ kind: 'enterFlow' as const, flow }),
    });

    const parts: HarnessStreamPart[] = [];
    const handle = runtime.run({
      sessionId: 'same-bot-e2e',
      input: 'start',
      driver: {
        async runAgentTurn() {
          return { text: '', toolResults: [] };
        },
        async awaitUser() {
          return { type: 'message', input: 'alpha' };
        },
        async runStructured() {
          return { choice: 'alpha' };
        },
      },
    });
    for await (const part of handle.events) {
      parts.push(part);
    }
    await handle;

    const emitted = parts.find((p) => p.type === 'interactive');
    expect(emitted?.type).toBe('interactive');
    if (emitted?.type !== 'interactive') throw new Error('expected interactive part');

    const store = new InMemoryWindowStore();
    const sink = createRecordingSink();
    const { pipeline } = engagementPipeline(store, sink);

    for (const platform of ['whatsapp', 'instagram', 'web'] as const) {
      sink.sendInteractiveCalls.length = 0;
      const outcome = await pipeline.send(
        outboundWithInteractive(platform, `t-${platform}`, emitted),
      );
      expect(outcome.kind).toBe('sent');
      expect(sink.sendInteractiveCalls).toHaveLength(1);
      const rendered = sink.sendInteractiveCalls[0]!.interactive;
      const ids =
        rendered.action.type === 'list'
          ? rendered.action.sections[0]!.rows.map((r) => r.id)
          : rendered.action.type === 'buttons'
            ? rendered.action.buttons.map((b) => b.id)
            : [];
      expect(ids).toEqual(sharedChoices.map((o) => o.id));
    }
  });

  it('window-safety: WA closed text → template; IG closed text → tag; IG interactive deferred; web recovery is a no-op', async () => {
    const store = new InMemoryWindowStore();
    const sink = createRecordingSink();
    const { pipeline } = engagementPipeline(store, sink);

    const waClosed = await pipeline.send({
      threadId: 't-wa',
      platform: 'whatsapp',
      payload: { kind: 'text', text: 'order update' },
      meta: { window: closedWindow, parts: [], sessionId: 'sess-1' },
    });
    expect(waClosed.kind).toBe('sent');
    expect(sink.sendTemplateCalls).toHaveLength(1);
    expect(sink.sendTemplateCalls[0]![0]).toBe('t-wa');
    expect(sink.sendTemplateCalls[0]![1].name).toBe('order_reminder');
    expect(sink.sendTextCalls).toBe(0);

    sink.sendTemplateCalls.length = 0;
    sink.sendTextWithTagCalls.length = 0;

    const igClosedText = await pipeline.send({
      threadId: 't-ig',
      platform: 'instagram',
      payload: { kind: 'text', text: 'agent reply' },
      meta: { window: closedWindow, parts: [], sessionId: 'sess-1' },
    });
    expect(igClosedText.kind).toBe('sent');
    expect(sink.sendTextWithTagCalls).toEqual([['t-ig', 'agent reply', 'HUMAN_AGENT']]);

    const igClosedInteractive = await pipeline.send({
      threadId: 't-ig',
      platform: 'instagram',
      payload: {
        kind: 'interactive',
        interactive: {
          type: 'buttons',
          body: 'pick',
          action: { type: 'buttons', buttons: [{ id: 'a', title: 'A' }] },
        },
      },
      meta: { window: closedWindow, parts: [], sessionId: 'sess-1' },
    });
    expect(igClosedInteractive).toEqual({
      kind: 'deferred',
      reason: 'window-closed-tag-text-only',
    });

    sink.sendInteractiveCalls.length = 0;
    const webClosedInteractive = await pipeline.send(
      outboundWithInteractive(
        'web',
        't-web',
        interactivePart(twoChoices, 'Confirm?'),
        closedWindow,
      ),
    );
    expect(webClosedInteractive.kind).toBe('deferred');
    expect(sink.sendInteractiveCalls).toHaveLength(0);

    const webOpen = await pipeline.send(
      outboundWithInteractive(
        'web',
        't-web',
        interactivePart(twoChoices, 'Confirm?'),
        openWindow,
      ),
    );
    expect(webOpen.kind).toBe('sent');
    expect(sink.sendInteractiveCalls).toHaveLength(1);
    expect(sink.sendInteractiveCalls[0]!.interactive.type).toBe('buttons');
  });

  it('matches standalone renderers for WA and IG (no drift from policy adapters)', () => {
    expect(renderChoices(sharedChoices, 'Pick one').type).toBe('list');
    expect(renderInstagramInteractive(sharedChoices, 'Pick one').type).toBe('list');
    const webButtons = webPolicy().renderInteractive(sharedChoices, 'Pick one');
    expect(webButtons.type).toBe('buttons');
    if (webButtons.action.type === 'buttons') {
      expect(webButtons.action.buttons.map((b) => b.id)).toEqual(
        sharedChoices.map((o) => o.id),
      );
    }
  });
});
