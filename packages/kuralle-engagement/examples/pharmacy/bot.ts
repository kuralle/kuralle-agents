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
  sessionConsentStore,
  sessionOwnershipStore,
  createInMemoryBroadcastLedger,
  createBroadcasts,
  createSimulator,
  type Simulator,
  type TemplateCatalog,
  type TemplateSelector,
  type BroadcastApi,
} from '@kuralle-agents/engagement';
import type { ConsentStore, OwnershipStore } from '@kuralle-agents/messaging';

export const COPAY_AMOUNT = 15;

export const RX_CHOICES = [
  { id: 'rx-amox', label: 'Amoxicillin 500mg' },
  { id: 'rx-lis', label: 'Lisinopril 10mg' },
] as const;

export const refillReminderTemplate: TemplateInfo = {
  id: 'tpl-refill-reminder',
  name: 'refill_reminder',
  language: 'en_US',
  status: 'APPROVED',
  category: 'UTILITY',
  components: [{ type: 'BODY', text: 'Time to refill your {{1}}? Reply to reorder.' }],
  quality: 'GREEN',
};

export const pharmacyTemplateCatalog: TemplateCatalog = {
  async approved() {
    return [
      {
        name: 'refill_reminder',
        language: 'en_US',
        category: 'utility',
        status: 'APPROVED',
        quality: 'GREEN',
        params: [{ key: '1', required: true }],
      },
    ];
  },
  validateParams(name, params) {
    if (name !== 'refill_reminder') {
      return { ok: false, errors: [`unknown template ${name}`] };
    }
    const ok = '1' in params;
    return { ok, errors: ok ? undefined : ['missing param 1'] };
  },
};

export function mockWhatsAppTemplatesClient(
  templates: TemplateInfo[] = [refillReminderTemplate],
): WhatsAppClient {
  return {
    templates: { list: async () => templates },
  } as unknown as WhatsAppClient;
}

export function defaultPharmacySelector(): TemplateSelector {
  return {
    async select({ flowState }) {
      const medication = String(flowState?.rxLabel ?? flowState?.rxId ?? 'medication');
      return { name: 'refill_reminder', language: 'en_US', params: { '1': medication } };
    },
  };
}

const identitySchema = z.object({
  fullName: z.string(),
  dob: z.string(),
});

const insuranceSchema = z.object({
  insurer: z.string().optional(),
  memberId: z.string().optional(),
  payOutOfPocket: z.boolean().optional(),
});

const addressSchema = z.object({
  address: z.string(),
});

const choiceSchema = z.object({ choice: z.string() });

const verifyPatientTool = defineTool({
  name: 'verifyPatient',
  description: 'Mock patient lookup by name and date of birth (YYYY-MM-DD).',
  input: z.object({ fullName: z.string(), dob: z.string() }),
  execute: async ({ fullName, dob }) => {
    const matched =
      fullName.toLowerCase().includes('jane') && /^\d{4}-\d{2}-\d{2}$/.test(dob);
    return matched
      ? { matched: true as const, patientId: 'patient-demo-1' }
      : { matched: false as const };
  },
});

const checkInteractionsTool = defineTool({
  name: 'checkInteractions',
  description: 'Mock drug interaction check for a prescription id.',
  input: z.object({ rxId: z.string() }),
  execute: async ({ rxId }) => ({
    note:
      rxId === 'rx-lis'
        ? 'Mild caution: monitor blood pressure when combining with NSAIDs.'
        : 'No known interactions for this refill.',
  }),
});

export const chargeCopayTool = defineTool({
  name: 'chargeCopay',
  description: 'Charge the prescription copay (requires human approval before running).',
  needsApproval: true,
  input: z.object({ amount: z.number() }),
  execute: async ({ amount }) => ({ charged: true, amount }),
});

export function buildRefillReminderText(state: FlowState): string {
  const med = state.rxLabel ?? state.rxId ?? 'your medication';
  return `Time to refill your ${med}? Reply to reorder.`;
}

export function rxLabelForId(rxId: string): string {
  return RX_CHOICES.find((c) => c.id === rxId)?.label ?? rxId;
}

export function buildPharmacyBot(model: LanguageModel) {
  const noMatchReply = reply({
    id: 'noMatch',
    instructions:
      'Apologize — we could not verify the patient record. This is a demo; no real PHI is stored.',
    next: () => ({ end: 'no-match' }),
  });

  const finalReply = reply({
    id: 'finalReply',
    instructions: ({ state }) => {
      const method = state.fulfilment === 'delivery' ? 'home delivery' : 'store pickup';
      const addr =
        state.fulfilment === 'delivery' && state.address
          ? ` to ${state.address}`
          : '';
      return [
        `Confirm the refill order (demo only, not a real prescription).`,
        `Interaction note: ${state.interactionNote ?? 'none'}.`,
        `Copay $${state.copayAmount ?? COPAY_AMOUNT} charged after approval.`,
        `${method}${addr}.`,
        `Text STOP anytime to opt out of refill reminders.`,
      ].join(' ');
    },
    next: () => ({ end: 'ordered' }),
  });

  const payment = action({
    id: 'payment',
    run: async (state, ctx) => {
      const result = (await ctx.tool('chargeCopay', { amount: COPAY_AMOUNT })) as {
        charged: boolean;
        amount: number;
      };
      state.copayAmount = result.amount;
      state.copayCharged = result.charged;
      return finalReply;
    },
  });

  const collectAddress = collect({
    id: 'collectAddress',
    schema: addressSchema,
    required: ['address'],
    instructions: () => 'Ask for the delivery street address in one message.',
    onComplete: (data, state) => {
      Object.assign(state, data as Record<string, unknown>);
      const bucket = state.__collect_collectAddress;
      if (bucket && typeof bucket === 'object' && !Array.isArray(bucket)) {
        Object.assign(state, bucket as Record<string, unknown>);
      }
      return payment;
    },
  });

  const fulfilment = withChoices(
    decide({
      id: 'fulfilment',
      instructions: 'Choose pickup or delivery.',
      schema: choiceSchema,
      decide: (sel, state) => {
        const choice = (sel as { choice: string }).choice;
        if (!choice) return 'stay';
        state.fulfilment = choice;
        if (choice === 'delivery') return collectAddress;
        return payment;
      },
    }),
    [
      { id: 'pickup', label: 'Store pickup' },
      { id: 'delivery', label: 'Home delivery' },
    ],
  );

  const insurance = collect({
    id: 'insurance',
    schema: insuranceSchema,
    instructions: () =>
      'Ask for insurance carrier and member id, or whether they will pay cash out of pocket.',
    onComplete: (data, state) => {
      Object.assign(state, data as Record<string, unknown>);
      const bucket = state.__collect_insurance;
      if (bucket && typeof bucket === 'object' && !Array.isArray(bucket)) {
        Object.assign(state, bucket as Record<string, unknown>);
      }
      return fulfilment;
    },
  });

  const interactionCheck = action({
    id: 'interactionCheck',
    run: async (state, ctx) => {
      const result = (await ctx.tool('checkInteractions', {
        rxId: String(state.rxId),
      })) as { note: string };
      state.interactionNote = result.note;
      return insurance;
    },
  });

  const chooseRx = withChoices(
    decide({
      id: 'chooseRx',
      instructions: 'Pick which active prescription to refill.',
      schema: choiceSchema,
      decide: (sel, state) => {
        const rxId = (sel as { choice: string }).choice;
        if (!rxId) return 'stay';
        state.rxId = rxId;
        state.rxLabel = rxLabelForId(rxId);
        return interactionCheck;
      },
    }),
    [...RX_CHOICES],
  );

  const verifyMatch = action({
    id: 'verifyMatch',
    run: async (state, ctx) => {
      const result = (await ctx.tool('verifyPatient', {
        fullName: String(state.fullName),
        dob: String(state.dob),
      })) as { matched: boolean; patientId?: string };
      if (!result.matched) return noMatchReply;
      state.patientId = result.patientId;
      return chooseRx;
    },
  });

  const verifyIdentity = collect({
    id: 'verifyIdentity',
    schema: identitySchema,
    required: ['fullName', 'dob'],
    instructions: () =>
      'Ask for full legal name and date of birth (YYYY-MM-DD). Demo only — no real PHI.',
    onComplete: (data, state) => {
      Object.assign(state, data as Record<string, unknown>);
      const bucket = state.__collect_verifyIdentity;
      if (bucket && typeof bucket === 'object' && !Array.isArray(bucket)) {
        Object.assign(state, bucket as Record<string, unknown>);
      }
      return verifyMatch;
    },
  });

  const greet = reply({
    id: 'greet',
    instructions:
      'Welcome to Acme Pharmacy refill (demo). Explain this is not real medical advice or PHI storage.',
    next: () => verifyIdentity,
  });

  const rxRefillFlow = defineFlow({
    name: 'rx-refill',
    description:
      'Prescription refill with identity verification, insurance, fulfilment, and copay approval.',
    start: greet,
    nodes: [
      greet,
      verifyIdentity,
      verifyMatch,
      noMatchReply,
      chooseRx,
      interactionCheck,
      insurance,
      fulfilment,
      collectAddress,
      payment,
      finalReply,
    ],
  });

  const agent = defineAgent({
    id: 'acme-pharmacy',
    name: 'Acme Pharmacy',
    instructions: [
      'You help customers refill prescriptions in a demo pharmacy bot.',
      'If the user asks to speak to a pharmacist, escalate immediately — do not continue the flow.',
      'Never claim to store real PHI; this is a demonstration.',
    ].join(' '),
    model,
    effectTools: {
      verifyPatient: verifyPatientTool,
      checkInteractions: checkInteractionsTool,
      chargeCopay: chargeCopayTool,
    },
    flows: [rxRefillFlow],
  });

  return {
    agent,
    flow: rxRefillFlow,
    chooseRx,
    fulfilment,
    verifyIdentity,
    interactionCheck,
    collectAddress,
    payment,
    finalReply,
  };
}

export interface BuildPharmacyRouterOptions {
  model: LanguageModel;
  platforms?: Record<string, PlatformClient>;
  simulatorChannels?: string[];
  simulatorDefaultCustomerId?: string;
  windowStore?: InMemoryWindowStore;
  selector?: TemplateSelector;
  catalog?: TemplateCatalog;
  whatsappClient?: WhatsAppClient;
  wabaId?: string;
}

export interface PharmacyRouterBundle {
  router: ReturnType<typeof createMessagingRouter>;
  runtime: ReturnType<typeof createRuntime>;
  eng: ReturnType<typeof engagement>;
  windowStore: InMemoryWindowStore;
  simulator?: Simulator;
  consent: ConsentStore;
  ownership: OwnershipStore;
  broadcasts: BroadcastApi;
  sendRefillReminder: (
    threadId: string,
    customerId: string,
    platform: string,
    state: FlowState,
  ) => Promise<SendOutcome>;
  outboundPipeline: (platform: PlatformClient) => OutboundPipeline;
}

export function buildPharmacyRouter(opts: BuildPharmacyRouterOptions): PharmacyRouterBundle {
  const windowStore = opts.windowStore ?? new InMemoryWindowStore();
  const catalog = opts.catalog ?? pharmacyTemplateCatalog;
  const selector = opts.selector ?? defaultPharmacySelector();
  const waClient = opts.whatsappClient ?? mockWhatsAppTemplatesClient();
  const strategist = createSmartSendStrategist({
    catalog,
    selector,
    audit: { record: () => {} },
  });

  const { agent } = buildPharmacyBot(opts.model);
  const runtime = createRuntime({
    agents: [agent],
    defaultAgentId: agent.id,
    defaultModel: opts.model,
  });

  const sessionStore = runtime.getSessionStore();
  const consent = sessionConsentStore(sessionStore, { defaultOptedIn: false });
  const ownership = sessionOwnershipStore(sessionStore);

  const ledger = createInMemoryBroadcastLedger();

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
    consent,
    ownership,
    windowStore,
    ledger,
  });

  let simulator: Simulator | undefined;
  let defaultPlatforms = opts.platforms ?? {};
  let router: ReturnType<typeof createMessagingRouter>;

  if (opts.simulatorChannels && opts.simulatorChannels.length > 0) {
    simulator = createSimulator({
      runtime,
      bridge: eng.bridge,
      channels: opts.simulatorChannels,
      windowStore,
      defaultCustomerId: opts.simulatorDefaultCustomerId
        ? () => opts.simulatorDefaultCustomerId!
        : undefined,
    });
    defaultPlatforms = simulator.platforms;
    router = simulator.router;
  } else {
    router = createMessagingRouter({
      runtime,
      platforms: defaultPlatforms,
      ...eng.bridge,
    });
  }

  const waPlatform = defaultPlatforms.whatsapp;
  const broadcasts = waPlatform
    ? createBroadcasts({
        pipeline: new OutboundPipeline([...(eng.bridge.outbound ?? []), windowGuard], waPlatform),
        consent,
        ledger,
        platform: 'whatsapp',
      })
    : eng.broadcasts;

  const outboundPipeline = (platform: PlatformClient) =>
    new OutboundPipeline([...(eng.bridge.outbound ?? []), windowGuard], platform);

  const sendRefillReminder = async (
    threadId: string,
    customerId: string,
    platform: string,
    state: FlowState,
  ): Promise<SendOutcome> => {
    const text = buildRefillReminderText(state);
    const window = await windowStore.get(threadId);
    const decision = await strategist.decide({ text, window, flowState: state });
    const platformClient = defaultPlatforms[platform];
    if (!platformClient) {
      throw new Error(`No platform client registered for "${platform}"`);
    }
    const pipeline = outboundPipeline(platformClient);
    if (decision.kind === 'template') {
      const req: OutboundRequest = {
        threadId,
        platform,
        payload: { kind: 'template', template: decision.template },
        meta: { window, parts: [], sessionId: threadId, userId: customerId },
      };
      return pipeline.send(req);
    }
    if (decision.kind === 'freeform') {
      return pipeline.send({
        threadId,
        platform,
        payload: { kind: 'text', text: decision.text },
        meta: { window, parts: [], sessionId: threadId, userId: customerId },
      });
    }
    return { kind: 'deferred', reason: decision.reason };
  };

  return {
    router,
    runtime,
    eng,
    windowStore,
    simulator,
    consent,
    ownership,
    broadcasts,
    sendRefillReminder,
    outboundPipeline,
  };
}
