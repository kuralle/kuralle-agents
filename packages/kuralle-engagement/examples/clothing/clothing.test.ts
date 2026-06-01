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
  OutboundTemplate,
  PlatformClient,
  SendResult,
} from '@kuralle-agents/messaging';
import { InboundResolverChain, InMemoryWindowStore } from '@kuralle-agents/messaging';
import {
  policyInboundResolver,
  renderChoices,
  renderInstagramInteractive,
  whatsappPolicy,
  webPolicy,
  instagramPolicy,
} from '@kuralle-agents/engagement';
import {
  buildClothingBot,
  buildClothingRouter,
  mockInstagramClient,
  mockWhatsAppTemplatesClient,
  promoDropTemplate,
  SIZE_CHOICES,
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
  sendTemplateCalls: Array<[string, { name: string }]>;
} {
  const sendTemplateCalls: Array<[string, { name: string }]> = [];
  return {
    sendTemplateCalls,
    sendText: async (to) => makeSendResult(to),
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

function clothingDriver(overrides?: {
  productChoice?: string;
  sizeChoice?: string;
  colorChoice?: string;
  cartChoice?: string;
  addressPayload?: Record<string, unknown>;
}): ChannelDriver {
  let cartChoiceConsumed = false;
  return {
    async runAgentTurn(resolved) {
      if (resolved.node.id.startsWith('address')) {
        const payload =
          overrides?.addressPayload ?? {
            name: 'Jane Doe',
            street: '22 Main St',
            city: 'Austin',
            zip: '78701',
          };
        return {
          text: '',
          toolResults: [
            {
              name: 'submit_address_data',
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
      if (node.id === 'pickProduct') {
        return { choice: overrides?.productChoice ?? '' };
      }
      if (node.id === 'pickSize') {
        return { choice: overrides?.sizeChoice ?? '' };
      }
      if (node.id === 'pickColor') {
        return { choice: overrides?.colorChoice ?? '' };
      }
      if (node.id === 'cartReview' && overrides?.cartChoice && !cartChoiceConsumed) {
        cartChoiceConsumed = true;
        return { choice: overrides.cartChoice };
      }
      return { choice: '' };
    },
  };
}

async function runShopSession(
  sessionId: string,
  turns: Array<{ driver: ChannelDriver; input?: string }>,
): Promise<RunState | undefined> {
  const { agent, flow } = buildClothingBot(stubModel);
  const sessionStore = new MemoryStore();
  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    sessionStore,
    defaultModel: stubModel,
    hostSelect: async () => ({ kind: 'enterFlow' as const, flow }),
  });

  for (const turn of turns) {
    const handle = runtime.run({
      sessionId,
      input: turn.input ?? '',
      driver: turn.driver,
    });
    for await (const _ of handle.events) {
      /* drain */
    }
    await handle;
  }

  const session = await sessionStore.get(sessionId);
  return persistedRunState(session, sessionId);
}

describe('clothing_example', () => {
  it('product_size_color_route_by_id', async () => {
    const { pickProduct, pickSize, pickColor } = buildClothingBot(stubModel);
    const state: Record<string, unknown> = {};

    await Promise.resolve(pickProduct.decide({ choice: 'hoodie' }, state));
    expect(state.productId).toBe('hoodie');
    expect(state.productName).toBe('Zip Hoodie');

    await Promise.resolve(pickSize.decide({ choice: 'm' }, state));
    expect(state.size).toBe('m');

    const transition = await Promise.resolve(pickColor.decide({ choice: 'navy' }, state));
    expect(state.color).toBe('navy');
    expect(transition).toBeDefined();

    const windowStore = new InMemoryWindowStore();
    const chain = new InboundResolverChain([
      policyInboundResolver([
        whatsappPolicy({
          client: mockWhatsAppTemplatesClient(),
          selector: { select: async () => null },
          windowStore,
          wabaId: 'waba-demo',
        }),
        webPolicy(),
      ]),
    ]);
    const waInbound = {
      id: 'm-size',
      platform: 'whatsapp',
      threadId: 't-size',
      customerId: 'guest-1',
      from: { id: 'guest-1' },
      timestamp: new Date(),
      type: 'interactive' as const,
      interactive: { type: 'button_reply' as const, id: 'xl', title: 'Extra Large' },
    };
    const resolved = await chain.resolve(waInbound);
    expect(resolved.selection?.id).toBe('xl');
    expect(resolved.input).toBe('xl');
  });

  it('cart_grows_and_shrinks_across_turns', async () => {
    const sessionId = 'cart-sess';

    const run = await runShopSession(sessionId, [
      {
        input: 'shop',
        driver: clothingDriver({
          productChoice: 'tee',
          sizeChoice: 'm',
          colorChoice: 'black',
        }),
      },
      {
        driver: clothingDriver({
          cartChoice: 'more',
          productChoice: 'jeans',
          sizeChoice: 'l',
          colorChoice: 'navy',
        }),
      },
      {
        driver: clothingDriver({ cartChoice: 'remove' }),
      },
    ]);
    expect((run?.state.cart as unknown[] | undefined)?.length).toBe(1);
  });

  it('size_list_renders_per_channel', () => {
    const options = [...SIZE_CHOICES];
    const prompt = 'Pick a size';

    const waMsg = renderChoices(options, prompt);
    const igMsg = renderInstagramInteractive(options, prompt);

    expect(waMsg.type).toBe('list');
    expect(igMsg.type).toBe('list');
    if (waMsg.action.type !== 'list' || igMsg.action.type !== 'list') {
      throw new Error('expected list actions');
    }

    const waIds = waMsg.action.sections[0]!.rows.map((r) => r.id);
    const igIds = igMsg.action.sections[0]!.rows.map((r) => r.id);
    expect(waIds).toEqual(['s', 'm', 'l', 'xl']);
    expect(igIds).toEqual(waIds);
  });

  it('checkout_extracts_address_into_state', async () => {
    const sessionId = 'addr-sess';
    const run = await runShopSession(sessionId, [
      {
        input: 'shop',
        driver: clothingDriver({
          productChoice: 'jeans',
          sizeChoice: 'l',
          colorChoice: 'black',
        }),
      },
      {
        driver: clothingDriver({
          cartChoice: 'checkout',
          addressPayload: {
            name: 'Jane Doe',
            street: '22 Main St',
            city: 'Austin',
            zip: '78701',
          },
        }),
      },
    ]);

    expect(run?.state.name).toBe('Jane Doe');
    expect(run?.state.street).toBe('22 Main St');
    expect(run?.state.city).toBe('Austin');
    expect(run?.state.zip).toBe('78701');
    expect(run?.state.orderNumber).toBeDefined();
    expect((run?.state.__completedFlows as string[] | undefined)?.includes('shop')).toBe(true);
  });

  it('promo_broadcast_idempotent_and_opt_in_only', async () => {
    const sink = createRecordingSink();
    const platform = createRecordingPlatform(sink);
    const { broadcasts, consent } = buildClothingRouter({
      model: stubModel,
      platforms: { whatsapp: platform },
    });

    const optedIn = 'cust-promo-in';
    const optedOut = 'cust-promo-out';
    const threadIn = 'thread-promo-in';
    const threadOut = 'thread-promo-out';

    await consent.optIn(optedIn);

    const first = await broadcasts.send({
      id: 'camp-promo-drop',
      template: { name: promoDropTemplate.name, language: 'en_US' },
      recipients: [
        { customerId: optedIn, threadId: threadIn },
        { customerId: optedOut, threadId: threadOut },
      ],
    });
    expect(first).toEqual({ sent: 1, skipped: 1 });
    expect(sink.sendTemplateCalls).toHaveLength(1);
    expect(sink.sendTemplateCalls[0]![1].name).toBe('promo_drop');

    const second = await broadcasts.send({
      id: 'camp-promo-drop',
      template: { name: promoDropTemplate.name, language: 'en_US' },
      recipients: [{ customerId: optedIn, threadId: threadIn }],
    });
    expect(second).toEqual({ sent: 0, skipped: 1 });
    expect(sink.sendTemplateCalls).toHaveLength(1);
  });
});
