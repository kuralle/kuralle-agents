import { describe, it, expect } from 'bun:test';
import { OutboundPipeline, windowGuard } from '@kuralle-agents/messaging';
import type {
  OutboundRequest,
  OutboundSink,
  SendOutcome,
  WindowState,
} from '@kuralle-agents/messaging';
import {
  createSmartSendStrategist,
  type AuditSink,
  type ConversionAudit,
  type SendDecision,
  type TemplateCatalog,
  type TemplateDescriptor,
  type TemplateSelector,
} from '../src/strategist.js';
import { strategistMiddleware } from '../src/strategist-middleware.js';
import { smartSend } from '../src/nodes.js';

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

function mockCatalog(
  approved: TemplateDescriptor[],
  validateOk = true,
): TemplateCatalog {
  return {
    approved: async () => approved,
    validateParams: () =>
      validateOk ? { ok: true } : { ok: false, errors: ['missing item'] },
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

function makeSendResult(threadId = 'thread-1') {
  return { messageId: 'msg-out', threadId, timestamp: new Date() };
}

function closedTextRequest(text = 'still want pizza?'): OutboundRequest {
  return {
    threadId: 'thread-1',
    platform: 'whatsapp',
    payload: { kind: 'text', text },
    meta: {
      window: closedWindow,
      parts: [],
      sessionId: 'sess-1',
    },
  };
}

function openTextRequest(text = 'hello'): OutboundRequest {
  return {
    threadId: 'thread-1',
    platform: 'whatsapp',
    payload: { kind: 'text', text },
    meta: {
      window: openWindow,
      parts: [],
      sessionId: 'sess-1',
    },
  };
}

function createTemplateSink(): OutboundSink & {
  sendTextCalls: number;
  sendTemplateCalls: Array<[string, { name: string }]>;
} {
  let sendTextCalls = 0;
  const sendTemplateCalls: Array<[string, { name: string }]> = [];
  return {
    get sendTextCalls() {
      return sendTextCalls;
    },
    sendTemplateCalls,
    sendText: async (to) => {
      sendTextCalls++;
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

function decisionKind(d: SendDecision): string {
  return d.kind;
}

function templateName(d: SendDecision): string | undefined {
  return d.kind === 'template' ? d.template.name : undefined;
}

describe('node_guard_parity', () => {
  it('middleware and smartSend agree on closed-window text decisions', async () => {
    const selector = mockSelector(async () => ({
      name: 'order_reminder',
      language: 'en',
      params: { item: 'pizza' },
    }));
    const strategist = createSmartSendStrategist({
      catalog: mockCatalog(approvedOnly),
      selector,
      audit: mockAudit(),
    });
    const text = 'still want your pizzas?';

    let mwPayloadKind: string | undefined;
    let mwDeferred: string | undefined;
    const mw = strategistMiddleware(strategist);
    const mwOutcome = await mw.send(closedTextRequest(text), async (req) => {
      mwPayloadKind = req.payload.kind;
      if (req.payload.kind === 'template') {
        return { kind: 'sent', result: makeSendResult() };
      }
      return { kind: 'sent', result: makeSendResult() };
    });
    if (mwOutcome.kind === 'deferred') {
      mwDeferred = mwOutcome.reason;
    }

    let nodeDecision: SendDecision | undefined;
    const node = smartSend(strategist, {
      id: 'parity',
      message: () => text,
      window: () => closedWindow,
      next: (d) => {
        nodeDecision = d;
        return 'stay';
      },
    });
    await node.run({});

    expect(nodeDecision).toBeDefined();
    if (mwDeferred !== undefined) {
      expect(nodeDecision!.kind).toBe('defer');
      expect((nodeDecision as { kind: 'defer'; reason: string }).reason).toBe(mwDeferred);
    } else {
      expect(mwPayloadKind).toBe('template');
      expect(nodeDecision!.kind).toBe('template');
      expect(templateName(nodeDecision!)).toBe('order_reminder');
    }
    expect(decisionKind(nodeDecision!)).toBe(mwDeferred ? 'defer' : 'template');
  });
});

describe('strategist_middleware_converts_closed_window', () => {
  it('pipeline delivers template to sink when window is closed', async () => {
    const strategist = createSmartSendStrategist({
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
      [strategistMiddleware(strategist), windowGuard],
      sink,
    );

    const outcome = await pipeline.send(closedTextRequest());

    expect(outcome.kind).toBe('sent');
    expect(sink.sendTextCalls).toBe(0);
    expect(sink.sendTemplateCalls).toEqual([['thread-1', { name: 'order_reminder' }]]);
  });
});

describe('strategist_middleware_defers_when_no_fit', () => {
  it('pipeline defers with zero sink calls when catalog is empty', async () => {
    const strategist = createSmartSendStrategist({
      catalog: mockCatalog([]),
      selector: mockSelector(async () => null),
      audit: mockAudit(),
    });
    const sink = createTemplateSink();
    const pipeline = new OutboundPipeline(
      [strategistMiddleware(strategist), windowGuard],
      sink,
    );

    const outcome = await pipeline.send(closedTextRequest());

    expect(outcome).toEqual({ kind: 'deferred', reason: 'no-approved-template' });
    expect(sink.sendTextCalls).toBe(0);
    expect(sink.sendTemplateCalls).toHaveLength(0);
  });
});

describe('window_open', () => {
  it('middleware passes text unchanged without calling selector', async () => {
    const selector = mockSelector(async () => ({
      name: 'order_reminder',
      language: 'en',
      params: { item: 'x' },
    }));
    const strategist = createSmartSendStrategist({
      catalog: mockCatalog(approvedOnly),
      selector,
      audit: mockAudit(),
    });
    const req = openTextRequest('hi there');
    let nextReq: OutboundRequest | undefined;
    const mw = strategistMiddleware(strategist);
    await mw.send(req, async (r) => {
      nextReq = r;
      return { kind: 'sent', result: makeSendResult() };
    });

    expect(selector.calls).toBe(0);
    expect(nextReq).toBeDefined();
    expect(nextReq!.payload).toEqual({ kind: 'text', text: 'hi there' });
  });
});

describe('strategistMiddleware', () => {
  it('returns middleware named strategist', () => {
    const strategist = createSmartSendStrategist({
      catalog: mockCatalog([]),
      selector: mockSelector(async () => null),
      audit: mockAudit(),
    });
    expect(strategistMiddleware(strategist).name).toBe('strategist');
  });

  it('passes non-text payloads through unchanged', async () => {
    const selector = mockSelector(async () => null);
    const strategist = createSmartSendStrategist({
      catalog: mockCatalog(approvedOnly),
      selector,
      audit: mockAudit(),
    });
    const req: OutboundRequest = {
      ...closedTextRequest(),
      payload: {
        kind: 'interactive',
        interactive: { type: 'button', body: { text: 'pick' }, action: { buttons: [] } },
      },
    };
    let seenPayload = false;
    const mw = strategistMiddleware(strategist);
    await mw.send(req, async (r) => {
      seenPayload = r.payload.kind === 'interactive';
      return { kind: 'sent', result: makeSendResult() };
    });

    expect(selector.calls).toBe(0);
    expect(seenPayload).toBe(true);
  });
});

describe('smartSend', () => {
  it('returns an action node that uses the shared strategist', async () => {
    const strategist = createSmartSendStrategist({
      catalog: mockCatalog(approvedOnly),
      selector: mockSelector(async () => ({
        name: 'order_reminder',
        language: 'en',
        params: { item: 'x' },
      })),
      audit: mockAudit(),
    });
    const node = smartSend(strategist, {
      id: 'send',
      message: () => 'remind me',
      window: () => closedWindow,
    });

    expect(node.kind).toBe('action');
    expect(node.id).toBe('send');
    const transition = await node.run({});
    expect(transition).toBe('stay');
  });
});
