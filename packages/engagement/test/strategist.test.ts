import { describe, it, expect } from 'bun:test';
import type { WindowState } from '@kuralle-agents/messaging';
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
): TemplateSelector & { calls: number; lastCandidates?: readonly TemplateDescriptor[] } {
  const state = { calls: 0, lastCandidates: undefined as readonly TemplateDescriptor[] | undefined };
  return {
    get calls() {
      return state.calls;
    },
    get lastCandidates() {
      return state.lastCandidates;
    },
    async select(input) {
      state.calls += 1;
      state.lastCandidates = input.candidates;
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

describe('window_open_no_selector_call', () => {
  it('returns freeform without calling the selector', async () => {
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

    const decision = await strategist.decide({
      text: 'still want pizza?',
      window: openWindow,
    });

    expect(decision).toEqual({ kind: 'freeform', text: 'still want pizza?' });
    expect(selector.calls).toBe(0);
  });
});

describe('strategist_filters_paused_templates', () => {
  it('passes only catalog.approved() candidates to the selector', async () => {
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

    await strategist.decide({ text: 'remind me', window: closedWindow });

    expect(selector.calls).toBe(1);
    expect(selector.lastCandidates).toEqual(approvedOnly);
    for (const c of selector.lastCandidates ?? []) {
      expect(c.status).toBe('APPROVED');
      expect(c.quality).not.toBe('PAUSED');
      expect(c.status).not.toBe('REJECTED');
    }
  });
});

describe('strategist_defers_on_bad_params', () => {
  it('defers when validateParams fails', async () => {
    const audit = mockAudit();
    const selector = mockSelector(async () => ({
      name: 'order_reminder',
      language: 'en',
      params: {},
    }));
    const strategist = createSmartSendStrategist({
      catalog: mockCatalog(approvedOnly, false),
      selector,
      audit,
    });

    const decision = await strategist.decide({ text: 'remind me', window: closedWindow });

    expect(decision).toEqual({ kind: 'defer', reason: 'param-validation-failed' });
    expect(audit.records).toHaveLength(0);
  });

  it('defers when selector throws', async () => {
    const audit = mockAudit();
    const strategist = createSmartSendStrategist({
      catalog: mockCatalog(approvedOnly),
      selector: mockSelector('throw'),
      audit,
    });

    const decision = await strategist.decide({ text: 'remind me', window: closedWindow });
    expect(decision).toEqual({ kind: 'defer', reason: 'selector-error' });
    expect(audit.records).toHaveLength(0);
  });

  it('defers when selector returns null', async () => {
    const strategist = createSmartSendStrategist({
      catalog: mockCatalog(approvedOnly),
      selector: mockSelector(async () => null),
      audit: mockAudit(),
    });

    const decision = await strategist.decide({ text: 'remind me', window: closedWindow });
    expect(decision).toEqual({ kind: 'defer', reason: 'no-template-fit' });
  });

  it('defers when approved catalog is empty', async () => {
    const strategist = createSmartSendStrategist({
      catalog: mockCatalog([]),
      selector: mockSelector(async () => null),
      audit: mockAudit(),
    });

    const decision = await strategist.decide({ text: 'remind me', window: closedWindow });
    expect(decision).toEqual({ kind: 'defer', reason: 'no-approved-template' });
  });

  it('defers when pick name is not among approved candidates', async () => {
    const strategist = createSmartSendStrategist({
      catalog: mockCatalog(approvedOnly),
      selector: mockSelector(async () => ({
        name: 'unknown_template',
        language: 'en',
        params: { item: 'x' },
      })),
      audit: mockAudit(),
    });

    const decision = await strategist.decide({ text: 'remind me', window: closedWindow });
    expect(decision).toEqual({ kind: 'defer', reason: 'no-template-fit' });
  });
});

describe('strategist_audits_conversion', () => {
  it('records audit once then returns template decision', async () => {
    const audit = mockAudit();
    const strategist = createSmartSendStrategist({
      catalog: mockCatalog(approvedOnly),
      selector: mockSelector(async () => ({
        name: 'order_reminder',
        language: 'en',
        params: { item: '2 pizzas' },
      })),
      audit,
    });

    const decision = await strategist.decide({
      text: 'still want your pizzas?',
      window: closedWindow,
      intent: 'reorder',
    });

    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]).toMatchObject({
      requestedText: 'still want your pizzas?',
      chosenTemplate: 'order_reminder',
      params: { item: '2 pizzas' },
    });
    expect(typeof audit.records[0]!.at).toBe('number');

    expect(decision.kind).toBe('template');
    if (decision.kind !== 'template') throw new Error('expected template');
    expect(decision.template).toEqual({
      name: 'order_reminder',
      language: 'en',
      namedParams: { item: '2 pizzas' },
    });
    expect(decision.selected).toEqual(approvedOnly[0]);
    expect(decision.audit).toBe(audit.records[0]);
  });
});
