import type { LanguageModel } from 'ai';
import { z } from 'zod';
import {
  action,
  collect,
  createRuntime,
  decide,
  defineAgent,
  defineFlow,
  defineTool,
  reply,
  type FlowState,
} from '@kuralle-agents/core';
import {
  createMessagingRouter,
  InMemoryWindowStore,
  OutboundPipeline,
  windowGuard,
  type OutboundRequest,
  type PlatformClient,
  type SendOutcome,
  type WindowState,
} from '@kuralle-agents/messaging';
import type { TemplateInfo, WhatsAppClient } from '@kuralle-agents/messaging-meta/whatsapp';
import {
  engagement,
  webPolicy,
  whatsappPolicy,
  withChoices,
  createSmartSendStrategist,
  type TemplateCatalog,
  type TemplateSelector,
} from '@kuralle-agents/engagement';

const bookingDetailsSchema = z.object({
  partySize: z.number().int().min(1).max(20),
  date: z.string(),
  time: z.string().optional(),
  name: z.string().optional(),
});

const choiceSchema = z.object({ choice: z.string() });

export const bookingHoldTemplate: TemplateInfo = {
  id: 'tpl-booking-hold',
  name: 'booking_hold',
  language: 'en_US',
  status: 'APPROVED',
  category: 'UTILITY',
  components: [{ type: 'BODY', text: 'Table for {{2}} on {{1}} is still held' }],
  quality: 'GREEN',
};

export const bookingTemplateCatalog: TemplateCatalog = {
  async approved() {
    return [
      {
        name: 'booking_hold',
        language: 'en_US',
        category: 'utility',
        status: 'APPROVED',
        quality: 'GREEN',
        params: [
          { key: '1', required: true },
          { key: '2', required: true },
        ],
      },
    ];
  },
  validateParams(name, params) {
    if (name !== 'booking_hold') {
      return { ok: false, errors: [`unknown template ${name}`] };
    }
    const ok = '1' in params && '2' in params;
    return { ok, errors: ok ? undefined : ['missing param 1 or 2'] };
  },
};

export function mockWhatsAppTemplatesClient(
  templates: TemplateInfo[] = [bookingHoldTemplate],
): WhatsAppClient {
  return {
    templates: { list: async () => templates },
  } as unknown as WhatsAppClient;
}

export function defaultBookingSelector(): TemplateSelector {
  return {
    async select({ flowState }) {
      const date = String(flowState?.date ?? '');
      const partySize = String(flowState?.partySize ?? '');
      return { name: 'booking_hold', language: 'en_US', params: { '1': date, '2': partySize } };
    },
  };
}

const checkAvailabilityTool = defineTool({
  name: 'checkAvailability',
  description: 'Return candidate reservation time slots for a date and party size.',
  input: z.object({
    date: z.string(),
    partySize: z.number().int().min(1).max(20),
  }),
  execute: async () => ({
    slots: ['18:30', '19:00', '20:15'] as const,
  }),
});

const createReservationTool = defineTool({
  name: 'createReservation',
  description: 'Create a reservation and return a confirmation code.',
  input: z.object({
    date: z.string(),
    partySize: z.number().int(),
    time: z.string(),
    name: z.string().optional(),
  }),
  execute: async ({ date, partySize, time, name }) => ({
    code: `BK-${date.replace(/\D/g, '').slice(-4)}-${time.replace(':', '')}`,
    date,
    partySize,
    time,
    name: name ?? 'Guest',
  }),
});

export function buildHoldReminderText(state: FlowState): string {
  const partySize = state.partySize ?? '?';
  const date = state.date ?? '?';
  return `Your table for ${partySize} on ${date} is still held — confirm?`;
}

export function buildBookingBot(model: LanguageModel) {
  const finalReply = reply({
    id: 'finalReply',
    instructions: ({ state }) =>
      `Confirm booking code ${state.confirmationCode} for ${state.partySize} guests on ${state.date} at ${state.confirmedTime}.`,
    next: () => ({ end: 'booked' }),
  });

  const book = action({
    id: 'book',
    run: async (state, ctx) => {
      const result = (await ctx.tool('createReservation', {
        date: String(state.date),
        partySize: Number(state.partySize),
        time: String(state.confirmedTime),
        name: state.name ? String(state.name) : undefined,
      })) as { code: string };
      state.confirmationCode = result.code;
      return finalReply;
    },
  });

  const confirm = withChoices(
    decide({
      id: 'confirm',
      instructions: 'Confirm or change the reservation.',
      schema: choiceSchema,
      decide: (sel, state) => {
        const choice = (sel as { choice: string }).choice;
        if (!choice) return 'stay';
        if (choice === 'yes') return book;
        return collectDetails;
      },
    }),
    [
      { id: 'yes', label: 'Confirm' },
      { id: 'no', label: 'Change' },
    ],
  );

  const pickSlot = withChoices(
    decide({
      id: 'pickSlot',
      instructions: 'Pick an available time slot.',
      schema: choiceSchema,
      decide: (sel, state) => {
        const slot = (sel as { choice: string }).choice;
        if (!slot) return 'stay';
        state.confirmedTime = slot;
        return confirm;
      },
    }),
    [
      { id: '18:30', label: '18:30' },
      { id: '19:00', label: '19:00' },
      { id: '20:15', label: '20:15' },
    ],
  );

  const checkAvailability = action({
    id: 'checkAvailability',
    run: async (state, ctx) => {
      const result = (await ctx.tool('checkAvailability', {
        date: String(state.date),
        partySize: Number(state.partySize),
      })) as { slots: readonly string[] };
      state.availableSlots = [...result.slots];
      pickSlot.choices = result.slots.map((slot) => ({ id: slot, label: slot }));
      return pickSlot;
    },
  });

  const collectDetails = collect({
    id: 'collectDetails',
    schema: bookingDetailsSchema,
    required: ['partySize', 'date'],
    instructions: () =>
      'Ask conversationally for date, time, party size, and name. Extract all provided fields.',
    onComplete: (data, state) => {
      Object.assign(state, data as Record<string, unknown>);
      const bucket = state.__collect_collectDetails;
      if (bucket && typeof bucket === 'object' && !Array.isArray(bucket)) {
        Object.assign(state, bucket as Record<string, unknown>);
      }
      return checkAvailability;
    },
  });

  const greet = reply({
    id: 'greet',
    instructions: 'Welcome the guest and ask what they would like to book.',
    next: () => collectDetails,
  });

  const reservationsFlow = defineFlow({
    name: 'reservations',
    description: 'Restaurant table reservations with extraction, slot pick, and confirm.',
    start: greet,
    nodes: [greet, collectDetails, checkAvailability, pickSlot, confirm, book, finalReply],
  });

  const agent = defineAgent({
    id: 'acme-bookings',
    name: 'Acme Bookings',
    instructions:
      'You are a friendly restaurant reservations assistant. Be concise for messaging channels.',
    model,
    effectTools: {
      checkAvailability: checkAvailabilityTool,
      createReservation: createReservationTool,
    },
    flows: [reservationsFlow],
  });

  return { agent, flow: reservationsFlow, pickSlot, confirm, collectDetails };
}

export interface BuildBookingRouterOptions {
  model: LanguageModel;
  platforms?: Record<string, PlatformClient>;
  windowStore?: InMemoryWindowStore;
  selector?: TemplateSelector;
  catalog?: TemplateCatalog;
  whatsappClient?: WhatsAppClient;
  wabaId?: string;
}

export interface BookingRouterBundle {
  router: ReturnType<typeof createMessagingRouter>;
  runtime: ReturnType<typeof createRuntime>;
  eng: ReturnType<typeof engagement>;
  windowStore: InMemoryWindowStore;
  sendHoldReminder: (
    threadId: string,
    platform: string,
    state: FlowState,
  ) => Promise<SendOutcome>;
  outboundPipeline: (platform: PlatformClient) => OutboundPipeline;
}

export function buildBookingRouter(opts: BuildBookingRouterOptions): BookingRouterBundle {
  const windowStore = opts.windowStore ?? new InMemoryWindowStore();
  const catalog = opts.catalog ?? bookingTemplateCatalog;
  const selector = opts.selector ?? defaultBookingSelector();
  const waClient = opts.whatsappClient ?? mockWhatsAppTemplatesClient();
  const strategist = createSmartSendStrategist({
    catalog,
    selector,
    audit: { record: () => {} },
  });

  const { agent } = buildBookingBot(opts.model);
  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    defaultModel: opts.model,
  });

  const eng = engagement({
    policies: [
      whatsappPolicy({
        client: waClient,
        selector,
        windowStore,
        wabaId: opts.wabaId ?? 'waba-demo',
      }),
      webPolicy(),
    ],
    windowStore,
  });

  const defaultPlatforms = opts.platforms ?? {};
  const router = createMessagingRouter({
    runtime,
    platforms: defaultPlatforms,
    ...eng.bridge,
  });

  const outboundPipeline = (platform: PlatformClient) =>
    new OutboundPipeline([...(eng.bridge.outbound ?? []), windowGuard], platform);

  const sendHoldReminder = async (
    threadId: string,
    platform: string,
    state: FlowState,
  ): Promise<SendOutcome> => {
    const text = buildHoldReminderText(state);
    const window = await windowStore.get(threadId);
    const decision = await strategist.decide({ text, window, flowState: state });
    if (decision.kind === 'template') {
      const platformClient = defaultPlatforms[platform];
      if (!platformClient) {
        throw new Error(`No platform client registered for "${platform}"`);
      }
      const pipeline = outboundPipeline(platformClient);
      const req: OutboundRequest = {
        threadId,
        platform,
        payload: {
          kind: 'template',
          template: decision.template,
        },
        meta: { window, parts: [], sessionId: threadId },
      };
      return pipeline.send(req);
    }
    if (decision.kind === 'freeform') {
      const platformClient = defaultPlatforms[platform];
      if (!platformClient) {
        throw new Error(`No platform client registered for "${platform}"`);
      }
      const pipeline = outboundPipeline(platformClient);
      return pipeline.send({
        threadId,
        platform,
        payload: { kind: 'text', text: decision.text },
        meta: { window, parts: [], sessionId: threadId },
      });
    }
    return { kind: 'deferred', reason: decision.reason };
  };

  return {
    router,
    runtime,
    eng,
    windowStore,
    sendHoldReminder,
    outboundPipeline,
  };
}
