/**
 * Acme Corp support agents — knowledge-powered customer service.
 */

import { defineAgent, type AgentConfig } from '@kuralle-agents/core';
import type { LanguageModel } from 'ai';

export function buildAgents(model: LanguageModel): AgentConfig[] {
  const support = defineAgent({
    id: 'support',
    name: 'Support Agent',
    model,
    instructions: [
      'You are a friendly Acme Corp customer support agent.',
      'Help customers with products, policies, orders, and account issues.',
      'Ground answers in the knowledge provided in your system prompt.',
      "Don't make up policies or prices — if unsure, say so.",
      'Be specific: quote exact numbers, timelines, and prices from the knowledge base.',
      'For refund requests, verify the refund policy applies before initiating.',
    ].join(' '),
    knowledge: { autoRetrieve: true },
  });

  const billing = defineAgent({
    id: 'billing',
    name: 'Billing Specialist',
    model,
    instructions: [
      'You are an Acme Corp billing specialist.',
      'Handle subscription pricing, plan comparisons, payment issues, and invoices.',
      'Be precise about pricing — always reference actual plan details from the knowledge base.',
    ].join(' '),
    knowledge: { autoRetrieve: true },
  });

  const triage = defineAgent({
    id: 'triage',
    name: 'Router',
    model,
    instructions: 'Route customers to the right specialist based on their question.',
    routes: [
      {
        agent: 'support',
        when: 'General support: refunds, shipping, warranty, products, orders, account issues',
      },
      {
        agent: 'billing',
        when: 'Billing: subscription pricing, plan changes, payment issues, invoices',
      },
    ],
    routing: {},
    agents: [support, billing],
  });

  return [triage, support, billing];
}
