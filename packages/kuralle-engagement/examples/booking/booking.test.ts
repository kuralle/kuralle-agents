import { describe, expect, it } from 'bun:test';
import type { LanguageModel } from 'ai';
import {
  createRuntime,
  MemoryStore,
  type ChannelDriver,
  type RunState,
  type Session,
} from '@kuralle-agents/core';
import type {
  OutboundSink,
  PlatformClient,
  SendResult,
  OutboundTemplate,
} from '@kuralle-agents/messaging';
import { InboundResolverChain, InMemoryWindowStore } from '@kuralle-agents/messaging';
import { policyInboundResolver, whatsappPolicy, webPolicy } from '@kuralle-agents/engagement';
import {
  buildBookingBot,
  buildBookingRouter,
  buildHoldReminderText,
  defaultBookingSelector,
  mockWhatsAppTemplatesClient,
} from './bot.js';

const stubModel = {} as LanguageModel;

type SessionWithRuns = Session & {
  durableRuns?: Record<string, { runState: RunState; steps: unknown[] }>;
};

function persistedRunState(session: Session | null, sessionId: string): RunState | undefined {
  const runs = (session as SessionWithRuns | null)?.durableRuns;
  return runs?.[sessionId]?.runState;
}

function createRecordingSink(): OutboundSink & {
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
      sendTextCalls += 1;
      return makeSendResult(to);
    },
    sendTemplate: async (to, template) => {
      sendTemplateCalls.push([to, template]);
      return makeSendResult(to);
    },
    sendInteractive: async (to) => makeSendResult(to),
    sendMedia: async (to) => makeSendResult(to),
  };
}

function makeSendResult(threadId: string): SendResult {
  return { messageId: 'out-1', threadId, timestamp: new Date() };
}

function createRecordingPlatform(
  sink: OutboundSink,
  platformName = 'whatsapp',
): PlatformClient & OutboundSink {
  return {
    platform: platformName,
    handleWebhook: async () => new Response('OK'),
    onMessage: () => {},
    onStatus: () => {},
    onReaction: () => {},
    sendText: (to, text) => sink.sendText!(to, text),
    sendTemplate: (to: string, template: OutboundTemplate) => sink.sendTemplate!(to, template),
    sendInteractive: (to, msg) => sink.sendInteractive!(to, msg),
    sendMedia: (to, media) => sink.sendMedia!(to, media),
    sendRaw: async (to) => makeSendResult(to),
    markAsRead: async () => {},
    sendTypingIndicator: async () => {},
    uploadMedia: async () => ({ mediaId: 'mock' }),
    downloadMedia: async () => ({ data: Buffer.from(''), mimeType: 'text/plain' }),
    formatConverter: {
      toPlainText: (t) => t,
      toMarkdown: (t) => t,
      toPlatformFormat: (t) => t,
    },
    webhookRouter: () => {
      throw new Error('not used in example tests');
    },
  };
}

function bookingDriver(overrides?: {
  collectPayload?: Record<string, unknown>;
  slotChoice?: string;
  confirmChoice?: string;
}): ChannelDriver {
  return {
    async runAgentTurn(resolved) {
      if (resolved.node.id.startsWith('collectDetails')) {
        const payload =
          overrides?.collectPayload ?? {
            partySize: 4,
            date: '2026-06-12',
            time: '19:00',
          };
        return {
          text: '',
          toolResults: [
            {
              name: 'submit_collectdetails_data',
              args: payload,
              result: payload,
            },
          ],
        };
      }
      return { text: `[${resolved.node.id}]`, toolResults: [] };
    },
    async awaitUser() {
      return { type: 'message', input: '' };
    },
    async runStructured(node) {
      if (node.id === 'pickSlot') {
        return { choice: overrides?.slotChoice ?? '' };
      }
      if (node.id === 'confirm') {
        return { choice: overrides?.confirmChoice ?? '' };
      }
      return { choice: '' };
    },
  };
}

describe('booking_example', () => {
  it('extracts_booking_details_into_state', async () => {
    const { agent, flow } = buildBookingBot(stubModel);
    const sessionStore = new MemoryStore();
    const sessionId = 'extract-sess';
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      sessionStore,
      defaultModel: stubModel,
      hostSelect: async () => ({ kind: 'enterFlow' as const, flow }),
    });

    const handle = runtime.run({
      sessionId,
      input: 'Table for 4 next Friday at 7pm',
      driver: bookingDriver({
        collectPayload: { partySize: 4, date: '2026-06-12', time: '19:00' },
      }),
    });
    for await (const _ of handle.events) {
      /* drain */
    }
    await handle;

    const session = await sessionStore.get(sessionId);
    const run = persistedRunState(session, sessionId);
    expect(run?.state.partySize).toBe(4);
    expect(run?.state.date).toBe('2026-06-12');
    expect(run?.state.time).toBe('19:00');
    expect(run?.activeNode).toBe('pickSlot');
  });

  it('slot_choice_routes_by_id', async () => {
    const { pickSlot, confirm } = buildBookingBot(stubModel);
    const state: Record<string, unknown> = {
      partySize: 4,
      date: '2026-06-12',
      availableSlots: ['18:30', '19:00', '20:15'],
    };

    const transition = await Promise.resolve(
      pickSlot.decide({ choice: '19:00' }, state),
    );
    const target =
      typeof transition === 'object' && transition !== null && 'id' in transition
        ? transition
        : typeof transition === 'function'
          ? transition()
          : transition;
    expect(state.confirmedTime).toBe('19:00');
    expect(target).toBe(confirm);

    const windowStore = new InMemoryWindowStore();
    const chain = new InboundResolverChain([
      policyInboundResolver([
        whatsappPolicy({
          client: mockWhatsAppTemplatesClient(),
          selector: defaultBookingSelector(),
          windowStore,
          wabaId: 'waba-demo',
        }),
        webPolicy(),
      ]),
    ]);
    const waInbound = {
      id: 'm-slot',
      platform: 'whatsapp',
      threadId: 't-slot',
      customerId: 'guest-1',
      from: { id: 'guest-1' },
      timestamp: new Date(),
      type: 'interactive' as const,
      interactive: { type: 'button_reply' as const, id: '19:00', title: 'Seven PM' },
    };
    const resolved = await chain.resolve(waInbound);
    expect(resolved.selection?.id).toBe('19:00');
    expect(resolved.input).toBe('19:00');
  });

  it('closed_window_hold_reminder_converts_to_template', async () => {
    const sink = createRecordingSink();
    const platform = createRecordingPlatform(sink);
    const threadId = 'wa-closed-hold';
    const { sendHoldReminder } = buildBookingRouter({
      model: stubModel,
      platforms: { whatsapp: platform },
      selector: defaultBookingSelector(),
    });

    const outcome = await sendHoldReminder(threadId, 'whatsapp', {
      partySize: 4,
      date: '2026-06-12',
    });

    expect(outcome.kind).toBe('sent');
    expect(sink.sendTemplateCalls).toHaveLength(1);
    expect(sink.sendTemplateCalls[0]![0]).toBe(threadId);
    expect(sink.sendTemplateCalls[0]![1].name).toBe('booking_hold');
    expect(sink.sendTextCalls).toBe(0);
    expect(buildHoldReminderText({ partySize: 4, date: '2026-06-12' })).toContain('4');
  });

  it('open_window_sends_freeform', async () => {
    const sink = createRecordingSink();
    const platform = createRecordingPlatform(sink);
    const threadId = 'wa-open-hold';
    const windowStore = new InMemoryWindowStore();
    await windowStore.recordInbound(threadId, new Date());

    const { sendHoldReminder } = buildBookingRouter({
      model: stubModel,
      platforms: { whatsapp: platform },
      windowStore,
      selector: defaultBookingSelector(),
    });

    const outcome = await sendHoldReminder(threadId, 'whatsapp', {
      partySize: 2,
      date: '2026-07-01',
    });

    expect(outcome.kind).toBe('sent');
    expect(sink.sendTextCalls).toBe(1);
    expect(sink.sendTemplateCalls).toHaveLength(0);
  });
});
