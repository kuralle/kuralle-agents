import { describe, expect, it } from 'bun:test';
import type { LanguageModel } from 'ai';
import {
  createRuntime,
  MemoryStore,
  type ChannelDriver,
  type RunState,
  type Session,
} from '@kuralle-agents/core';
import { createMockRuntime } from '@kuralle-agents/core/testing';
import type { HarnessStreamPart } from '@kuralle-agents/core';
import type {
  OutboundSink,
  OutboundTemplate,
  PlatformClient,
  SendResult,
  InboundMessage,
} from '@kuralle-agents/messaging';
import { InboundResolverChain, InMemoryWindowStore } from '@kuralle-agents/messaging';
import { policyInboundResolver, whatsappPolicy, webPolicy } from '@kuralle-agents/engagement';
import {
  buildPharmacyBot,
  buildPharmacyRouter,
  buildRefillReminderText,
  defaultPharmacySelector,
  mockWhatsAppTemplatesClient,
  refillReminderTemplate,
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
): PlatformClient & OutboundSink & {
  _messageHandlers: Array<(message: InboundMessage, raw: unknown) => Promise<void>>;
} {
  const messageHandlers: Array<(message: InboundMessage, raw: unknown) => Promise<void>> = [];
  return {
    platform: platformName,
    handleWebhook: async () => new Response('OK'),
    onMessage: (handler) => {
      messageHandlers.push(handler);
    },
    _messageHandlers: messageHandlers,
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

function pharmacyDriver(overrides?: {
  identityPayload?: Record<string, unknown>;
  insurancePayload?: Record<string, unknown>;
  addressPayload?: Record<string, unknown>;
  rxChoice?: string;
  fulfilmentChoice?: string;
}): ChannelDriver {
  return {
    async runAgentTurn(resolved) {
      if (resolved.node.id.startsWith('verifyIdentity')) {
        const payload =
          overrides?.identityPayload ?? {
            fullName: 'Jane Demo',
            dob: '1990-05-15',
          };
        return {
          text: '',
          toolResults: [
            {
              name: 'submit_verifyidentity_data',
              args: payload,
              result: payload,
            },
          ],
        };
      }
      if (resolved.node.id.startsWith('insurance')) {
        const payload =
          overrides?.insurancePayload ?? {
            insurer: 'BlueCross',
            memberId: '12345',
          };
        return {
          text: '',
          toolResults: [
            {
              name: 'submit_insurance_data',
              args: payload,
              result: payload,
            },
          ],
        };
      }
      if (resolved.node.id.startsWith('collectAddress')) {
        const payload = overrides?.addressPayload ?? { address: '123 Main St' };
        return {
          text: '',
          toolResults: [
            {
              name: 'submit_collectaddress_data',
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
      if (node.id === 'chooseRx') {
        return { choice: overrides?.rxChoice ?? '' };
      }
      if (node.id === 'fulfilment') {
        return { choice: overrides?.fulfilmentChoice ?? '' };
      }
      return { choice: '' };
    },
  };
}

type MockPlatform = PlatformClient & {
  _messageHandlers: Array<(message: InboundMessage, raw: unknown) => Promise<void>>;
  sendTemplate: (to: string, template: OutboundTemplate) => Promise<SendResult>;
};

function createRouterMockPlatform(): MockPlatform {
  const messageHandlers: Array<(message: InboundMessage, raw: unknown) => Promise<void>> = [];
  return {
    platform: 'whatsapp',
    handleWebhook: async () => new Response('OK'),
    onMessage: (h) => messageHandlers.push(h),
    onStatus: () => {},
    onReaction: () => {},
    sendText: async () => makeSendResult('thread'),
    sendTemplate: async () => makeSendResult('thread'),
    sendInteractive: async () => makeSendResult('thread'),
    sendMedia: async () => makeSendResult('thread'),
    sendRaw: async () => makeSendResult('thread'),
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
      throw new Error('not used');
    },
    _messageHandlers: messageHandlers,
  };
}

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'msg-1',
    platform: 'whatsapp',
    threadId: 'thread-pharm-1',
    customerId: 'cust-pharm-1',
    from: { id: 'cust-pharm-1' },
    timestamp: new Date(),
    type: 'text',
    text: 'hello',
    ...overrides,
  };
}

async function* humanHandoffStream(): AsyncGenerator<HarnessStreamPart> {
  yield { type: 'handoff', targetAgent: 'human', reason: 'escalate' };
  yield { type: 'done', sessionId: 'thread-pharm-1' };
}

describe('pharmacy_example', () => {
  it('verify_identity_extracts_name_dob', async () => {
    const { agent, flow } = buildPharmacyBot(stubModel);
    const sessionStore = new MemoryStore();
    const sessionId = 'extract-pharm';
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      sessionStore,
      defaultModel: stubModel,
      hostSelect: async () => ({ kind: 'enterFlow' as const, flow }),
    });

    const handle = runtime.run({
      sessionId,
      input: 'Jane Demo born 1990-05-15',
      driver: pharmacyDriver({
        identityPayload: { fullName: 'Jane Demo', dob: '1990-05-15' },
      }),
    });
    for await (const _ of handle.events) {
      /* drain */
    }
    await handle;

    const session = await sessionStore.get(sessionId);
    const run = persistedRunState(session, sessionId);
    expect(run?.state.fullName).toBe('Jane Demo');
    expect(run?.state.dob).toBe('1990-05-15');
    expect(run?.activeNode).toBe('chooseRx');
  });

  it('rx_choice_routes_by_id', async () => {
    const { chooseRx, interactionCheck } = buildPharmacyBot(stubModel);
    const state: Record<string, unknown> = { rxId: '', patientId: 'p1' };

    const transition = await Promise.resolve(
      chooseRx.decide?.({ choice: 'rx-lis' }, state),
    );
    const target =
      typeof transition === 'object' && transition !== null && 'id' in transition
        ? transition
        : typeof transition === 'function'
          ? transition()
          : transition;
    expect(state.rxId).toBe('rx-lis');
    expect(state.rxLabel).toBe('Lisinopril 10mg');
    expect(target).toBe(interactionCheck);

    const windowStore = new InMemoryWindowStore();
    const chain = new InboundResolverChain([
      policyInboundResolver([
        whatsappPolicy({
          client: mockWhatsAppTemplatesClient(),
          selector: defaultPharmacySelector(),
          windowStore,
          wabaId: 'waba-demo',
        }),
        webPolicy(),
      ]),
    ]);
    const waInbound = {
      id: 'm-rx',
      platform: 'whatsapp',
      threadId: 't-rx',
      customerId: 'guest-1',
      from: { id: 'guest-1' },
      timestamp: new Date(),
      type: 'interactive' as const,
      interactive: { type: 'button_reply' as const, id: 'rx-lis', title: 'Wrong label' },
    };
    const resolved = await chain.resolve(waInbound);
    expect(resolved.selection?.id).toBe('rx-lis');
    expect(resolved.input).toBe('rx-lis');
  });

  it('fulfilment_delivery_collects_address', async () => {
    const { fulfilment, collectAddress } = buildPharmacyBot(stubModel);
    const state: Record<string, unknown> = {};

    const transition = await Promise.resolve(
      fulfilment.decide?.({ choice: 'delivery' }, state),
    );
    const target =
      typeof transition === 'object' && transition !== null && 'id' in transition
        ? transition
        : typeof transition === 'function'
          ? transition()
          : transition;
    expect(state.fulfilment).toBe('delivery');
    expect(target).toBe(collectAddress);
  });

  it('refill_reminder_converts_to_template_on_closed_window', async () => {
    const sink = createRecordingSink();
    const platform = createRecordingPlatform(sink);
    const threadId = 'wa-closed-refill';
    const customerId = 'cust-refill-1';
    const { sendRefillReminder, consent } = buildPharmacyRouter({
      model: stubModel,
      platforms: { whatsapp: platform },
      selector: defaultPharmacySelector(),
    });

    await consent.optIn(customerId);

    const outcome = await sendRefillReminder(threadId, customerId, 'whatsapp', {
      rxId: 'rx-amox',
      rxLabel: 'Amoxicillin 500mg',
    });

    expect(outcome.kind).toBe('sent');
    expect(sink.sendTemplateCalls).toHaveLength(1);
    expect(sink.sendTemplateCalls[0]![1].name).toBe('refill_reminder');
    expect(sink.sendTextCalls).toBe(0);
    expect(buildRefillReminderText({ rxLabel: 'Amoxicillin 500mg' })).toContain('Amoxicillin');
  });

  it('not_opted_in_blocks_refill_reminder', async () => {
    const sink = createRecordingSink();
    const platform = createRecordingPlatform(sink);
    const { broadcasts } = buildPharmacyRouter({
      model: stubModel,
      platforms: { whatsapp: platform },
    });

    const result = await broadcasts.send({
      id: 'camp-refill-blocked',
      template: { name: 'refill_reminder', language: 'en_US' },
      recipients: [{ customerId: 'cust-no-opt', threadId: 'thread-no-opt' }],
    });

    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(sink.sendTemplateCalls).toHaveLength(0);
  });

  it('stop_halts_reminders', async () => {
    const sink = createRecordingSink();
    const platform = createRecordingPlatform(sink);
    const { broadcasts, consent } = buildPharmacyRouter({
      model: stubModel,
      platforms: { whatsapp: platform },
    });

    const customerId = 'cust-stop-1';
    const threadId = 'thread-stop-1';
    await consent.optIn(customerId);

    const first = await broadcasts.send({
      id: 'camp-before-stop',
      template: { name: refillReminderTemplate.name, language: 'en_US' },
      recipients: [{ customerId, threadId }],
    });
    expect(first.sent).toBe(1);
    expect(sink.sendTemplateCalls).toHaveLength(1);

    const handler = platform._messageHandlers[0]!;
    await handler(
      makeMessage({
        id: 'stop-1',
        threadId,
        customerId,
        text: 'STOP',
      }),
      {},
    );

    expect(await consent.isOptedIn(customerId)).toBe(false);

    const second = await broadcasts.send({
      id: 'camp-after-stop',
      template: { name: refillReminderTemplate.name, language: 'en_US' },
      recipients: [{ customerId, threadId }],
    });
    expect(second.sent).toBe(0);
    expect(second.skipped).toBe(1);
    expect(sink.sendTemplateCalls).toHaveLength(1);
  });

  it('escalate_to_pharmacist_claims_ownership', async () => {
    const platform = createRouterMockPlatform();
    let runCount = 0;
    const runtime = createMockRuntime(humanHandoffStream(), {
      onRun: () => {
        runCount++;
      },
    });

    const bundle = buildPharmacyRouter({
      model: stubModel,
      platforms: {},
    });

    const { createMessagingRouter } = await import('@kuralle-agents/messaging');
    createMessagingRouter({
      runtime,
      platforms: { whatsapp: platform },
      ...bundle.eng.bridge,
    });

    const handler = platform._messageHandlers[0]!;
    await handler(
      makeMessage({ id: 'esc-1', text: 'speak to a pharmacist' }),
      {},
    );

    expect(await bundle.ownership.owner('thread-pharm-1')).toBe('human');

    await handler(makeMessage({ id: 'esc-2', text: 'still waiting' }), {});
    expect(runCount).toBe(1);
  });
});
