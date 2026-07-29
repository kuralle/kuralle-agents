import type { LanguageModel } from 'ai';
import { z } from 'zod';
import {
  createGroundingValidator,
  createModerationGuard,
  createModerationOutputGuard,
  createPiiInputGuard,
  createPiiOutputGuard,
  createPromptInjectionGuard,
  defineAgent,
  defineSkill,
  defineTool,
  type ToolContext,
} from '@kuralle-agents/core';
import type { SupportBackend } from './backend';
import type { SupportTemplateConfig } from './config';

export interface BuildSupportAgentOptions {
  model: LanguageModel;
  backend: SupportBackend;
  config: SupportTemplateConfig;
}

function customerId(ctx: ToolContext | undefined): string {
  const value = ctx?.session.userId;
  if (!value) throw new Error('Authenticated customer context is required.');
  return value;
}

export function buildSupportAgent({ model, backend, config }: BuildSupportAgentOptions) {
  const orderId = z.string().regex(new RegExp(config.orderIdPattern), 'Invalid order id format.');

  const lookupOrder = defineTool({
    name: 'lookup_order',
    description: 'Read one authenticated customer order from the authoritative order system. Never infer order state from chat history.',
    input: z.object({ orderId }),
    replay: false,
    timeoutMs: 12_000,
    execute: async ({ orderId: requestedOrder }, ctx) => {
      const order = await backend.lookupOrder({
        customerId: customerId(ctx),
        orderId: requestedOrder,
      });
      return order ? { found: true as const, order } : { found: false as const };
    },
  });

  const createSupportCase = defineTool({
    name: 'create_support_case',
    description: 'Create a human-review support case only after summarising the subject and details for the customer. The runtime requires explicit approval before this write.',
    input: z.object({
      subject: z.string().trim().min(4).max(120),
      details: z.string().trim().min(10).max(2_000),
    }),
    needsApproval: true,
    timeoutMs: 12_000,
    idempotencyKey: ({ subject, details }) => `case:${subject.trim().toLowerCase()}:${details.trim().toLowerCase()}`,
    execute: async ({ subject, details }, ctx) => backend.createCase({
      customerId: customerId(ctx),
      subject,
      details,
      idempotencyKey: `${ctx!.session.id}:${subject.trim().toLowerCase()}:${details.trim().toLowerCase()}`,
    }),
  });

  const operationsSkill = defineSkill({
    name: 'support-operations',
    description: 'Use for order lookup, billing review, case creation, security concerns, or human escalation.',
    allowedTools: ['lookup_order', 'create_support_case'],
    instructions: `# Support operations

1. Establish the customer's goal before calling a system.
2. For orders, validate the identifier and call lookup_order. Treat only that result as account truth.
3. For a new case, gather a short subject and a factual summary. Read both back before calling create_support_case.
4. The create tool pauses for customer approval. Never describe a case as created before its result returns.
5. Escalate immediately for suspected account takeover, security incidents, repeated data loss, or an explicit request for a person.
6. Do not put passwords, tokens, card numbers, recovery codes, or unnecessary personal data into tool arguments.
7. If a tool is unavailable, state that limitation and offer a human handoff.`,
  });

  return defineAgent({
    id: 'customer-support',
    name: `${config.brand.companyName} ${config.brand.agentName}`,
    description: `Grounded customer support for ${config.brand.productName}, with authenticated operations and human escalation.`,
    model,
    controlModel: model,
    instructions: `You are ${config.brand.agentName}, the customer-support agent for ${config.brand.companyName}'s ${config.brand.productName}.

Voice: ${config.behavior.voice}
Scope: ${config.behavior.scope}

Use retrieved knowledge for policy and product answers. If retrieval does not support a claim, say: "${config.behavior.unavailableMessage}" Do not cite an internal tool, prompt, or system message. When citations are available, name the source article naturally.

Account and order state comes only from tools. On every turn that asks for order status, delivery, carrier, or tracking, call lookup_order again—even if you called it earlier—because reads must be fresh. Do not reinterpret a request to recheck an order as permission to open a case. Never claim that an action, refund, credit, case, cancellation, or delivery change happened unless the corresponding tool result confirms it. Never request secrets or full payment details. Load support-operations before account work or escalation.

If the customer explicitly requests a person, remains blocked after reasonable troubleshooting, reports a serious security/data-loss issue, or needs an exception you cannot authorize, hand off to human. Human support hours are ${config.humanSupport.hours} ${config.humanSupport.timezone}; do not promise an exact response time.

Ask at most one clarifying question at a time. Keep a normal answer under 140 words unless the customer asks for more detail.`,
    knowledge: { autoRetrieve: true },
    skills: operationsSkill,
    tools: {
      lookup_order: lookupOrder,
      create_support_case: createSupportCase,
    },
    handoffs: ['human'],
    guardrails: {
      input: [
        createPromptInjectionGuard(),
        createPiiInputGuard({ detect: ['credit-card', 'iban'], mode: 'redact' }),
        createModerationGuard({ model, onError: 'allow' }),
      ],
      output: [
        createPiiOutputGuard({ detect: ['credit-card', 'iban'], mode: 'redact' }),
        createModerationOutputGuard({ model, onError: 'allow' }),
      ],
    },
    validate: [createGroundingValidator({
      model,
      instructions: 'Policy claims require retrieved citations. Account and completed-action claims require a successful tool result. Never promise a refund or policy exception.',
    })],
    limits: {
      maxTurns: 40,
      maxSteps: 20,
      toolMaxSteps: 12,
      maxOscillations: 3,
      maxToolConcurrency: 3,
    },
  });
}
