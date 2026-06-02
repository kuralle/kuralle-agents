import { describe, expect, it } from 'bun:test';
import type { ChoiceOption, HarnessStreamPart } from '@kuralle-agents/core';
import type { Runtime } from '@kuralle-agents/core';
import { createMockRuntime } from '@kuralle-agents/core/testing';
import { InMemoryWindowStore, OutboundPipeline, windowGuard } from '@kuralle-agents/messaging';
import type { TemplateInfo, WhatsAppClient } from '@kuralle-agents/messaging-meta/whatsapp';
import {
  engagement,
  instagramPolicy,
  webPolicy,
  whatsappPolicy,
  type TemplateSelector,
} from '../src/index.js';
import { createSimulator } from '../src/simulator.js';

const fourChoices: ChoiceOption[] = [
  { id: 's', label: 'S' },
  { id: 'm', label: 'M' },
  { id: 'l', label: 'L' },
  { id: 'xl', label: 'XL' },
];

function orderReminderTemplate(): TemplateInfo {
  return {
    id: 'tpl-order',
    name: 'order_reminder',
    language: 'en',
    status: 'APPROVED',
    category: 'UTILITY',
    components: [{ type: 'BODY', text: 'Your order' }],
    quality: 'GREEN',
  };
}

function mockWhatsAppClient(): WhatsAppClient {
  return {
    templates: { list: async () => [orderReminderTemplate()] },
  } as unknown as WhatsAppClient;
}

const mockSelector: TemplateSelector = {
  async select() {
    return { name: 'order_reminder', language: 'en', params: { item: 'pizza' } };
  },
};

function mockRuntime(parts: HarnessStreamPart[]): Runtime {
  return createMockRuntime(parts) as unknown as Runtime;
}

function buildPolicies(windowStore: InMemoryWindowStore, channels: string[]) {
  return [
    whatsappPolicy({
      client: mockWhatsAppClient(),
      selector: mockSelector,
      windowStore,
      wabaId: 'waba-sim',
    }),
    webPolicy(),
    instagramPolicy({ client: {} as never, windowStore }),
  ].filter((p) => channels.includes(p.channel));
}

function buildSimulator(
  parts: HarnessStreamPart[],
  channels: string[] = ['whatsapp', 'web'],
) {
  const windowStore = new InMemoryWindowStore();
  const policies = buildPolicies(windowStore, channels);
  const eng = engagement({ policies, windowStore });
  const runtime = mockRuntime(parts);
  const sim = createSimulator({
    runtime,
    bridge: eng.bridge,
    channels,
    windowStore,
  });
  return { sim, windowStore, eng, policies };
}

describe('simulator_drives_multi_turn', () => {
  it('returns rendered sends per turn and accumulates history', async () => {
    const parts: HarnessStreamPart[] = [
      { type: 'text-delta', text: 'Hello there' },
      { type: 'done', sessionId: 'thread-1' },
    ];
    const { sim } = buildSimulator(parts);

    const turn1 = await sim.send('whatsapp', 'thread-1', { text: 'Hi' });
    expect(turn1.some((s) => s.kind === 'text' && s.detail.includes('Hello'))).toBe(true);

    const turn2 = await sim.send('whatsapp', 'thread-1', { text: 'Again' });
    expect(turn2.some((s) => s.kind === 'text')).toBe(true);
    expect(sim.sends().length).toBeGreaterThan(turn1.length);
  });
});

describe('simulator_renders_per_channel', () => {
  it('renders list on WhatsApp and buttons on web for the same choice set', async () => {
    const channels = ['whatsapp', 'web'];
    const windowStore = new InMemoryWindowStore();
    const policies = buildPolicies(windowStore, channels);
    const eng = engagement({ policies, windowStore });
    const sim = createSimulator({
      runtime: mockRuntime([]),
      bridge: eng.bridge,
      channels,
      windowStore,
    });

    const openWindow = { open: true as const, expiresAt: new Date('2099-01-01') };
    const waPolicy = policies.find((p) => p.channel === 'whatsapp')!;
    const webPolicyInst = policies.find((p) => p.channel === 'web')!;

    const waPipeline = new OutboundPipeline(
      [...(eng.bridge.outbound ?? []), windowGuard],
      sim.platforms.whatsapp,
    );
    const webPipeline = new OutboundPipeline(
      [...(eng.bridge.outbound ?? []), windowGuard],
      sim.platforms.web,
    );

    await waPipeline.send({
      threadId: 't-wa',
      platform: 'whatsapp',
      payload: {
        kind: 'interactive',
        interactive: waPolicy.renderInteractive(fourChoices, 'Pick a size'),
      },
      meta: { window: openWindow, parts: [], sessionId: 't-wa' },
    });
    await webPipeline.send({
      threadId: 't-web',
      platform: 'web',
      payload: {
        kind: 'interactive',
        interactive: webPolicyInst.renderInteractive(fourChoices, 'Pick a size'),
      },
      meta: { window: openWindow, parts: [], sessionId: 't-web' },
    });

    const waInteractive = sim.sends('whatsapp').find((s) => s.kind === 'interactive');
    const webInteractive = sim.sends('web').find((s) => s.kind === 'interactive');

    expect(waInteractive?.detail.startsWith('[list]')).toBe(true);
    expect(waInteractive?.detail).toContain('(s:S)');
    expect(webInteractive?.detail.startsWith('[buttons]')).toBe(true);
    expect(webInteractive?.detail).toContain('(s:S)');
  });
});

describe('simulator_reports_window_state', () => {
  it('reports an open window after an inbound turn on a windowed channel', async () => {
    const { sim } = buildSimulator(
      [{ type: 'text-delta', text: 'ok' }, { type: 'done', sessionId: 't-win' }],
      ['whatsapp'],
    );

    const before = await sim.window('t-win');
    expect(before.open).toBe(false);

    await sim.send('whatsapp', 't-win', { text: 'hello' });

    const after = await sim.window('t-win');
    expect(after.open).toBe(true);
    expect(after.expiresAt).toBeInstanceOf(Date);
  });
});
