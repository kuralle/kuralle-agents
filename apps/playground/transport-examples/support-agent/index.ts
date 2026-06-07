/**
 * Simple Customer Support Agent Configuration
 *
 * Reused across all transport examples for consistency.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import { createRuntime } from '@kuralle-agents/core';
import { defineAgent } from '@kuralle-agents/core';
import { wireTools } from '../../_shared/runtime/v2Tools.js';

/**
 * Product catalog for customer support
 */
const PRODUCT_CATALOG = {
  'basic-plan': {
    name: 'Basic Plan',
    price: '$9.99/month',
    features: ['5 GB storage', 'Email support', 'Basic analytics'],
  },
  'pro-plan': {
    name: 'Pro Plan',
    price: '$29.99/month',
    features: ['100 GB storage', 'Priority support', 'Advanced analytics', 'API access'],
  },
  'enterprise-plan': {
    name: 'Enterprise Plan',
    price: '$99.99/month',
    features: ['Unlimited storage', '24/7 phone support', 'Custom integrations', 'Dedicated account manager'],
  },
};

/**
 * Order lookup tool
 */
export const lookupOrder = tool({
  description: 'Look up order status by order ID',
  inputSchema: z.object({
    orderId: z.string().describe('The order ID (e.g., ORD-12345)'),
  }),
  execute: async ({ orderId }) => {
    // Simulated order lookup
    return {
      orderId,
      status: 'Shipped',
      estimatedDelivery: '2025-03-10',
      trackingNumber: '1Z999AA1' + Math.random().toString(36).substring(2, 8),
    };
  },
});

/**
 * Product information tool
 */
export const getProductInfo = tool({
  description: 'Get information about a product plan',
  inputSchema: z.object({
    planId: z.enum(['basic-plan', 'pro-plan', 'enterprise-plan']).describe('The plan identifier'),
  }),
  execute: async ({ planId }) => {
    const product = PRODUCT_CATALOG[planId];
    return {
      name: product.name,
      price: product.price,
      features: product.features,
    };
  },
});

/**
 * Transfer to human agent tool
 */
export const transferToHuman = tool({
  description: 'Transfer the customer to a human agent',
  inputSchema: z.object({
    reason: z.string().describe('The reason for transfer'),
  }),
  execute: async ({ reason }) => {
    return {
      transferred: true,
      reason,
      message: 'Connecting you to a human agent...',
    };
  },
});

export const supportInstructions = `You are a friendly customer support representative for Acme Inc.

Your role:
- Help customers with product questions
- Look up order status
- Explain plan features and pricing
- Handle returns and exchanges
- Transfer to human agent for complex issues

Guidelines:
- Be friendly and professional
- Keep responses concise (1-2 sentences when possible)
- Ask clarifying questions if the customer's need is unclear
- Always verify order IDs before looking up status
- For billing issues, transfer to human agent
- For technical support, transfer to human agent

Product Plans:
- Basic Plan: $9.99/month - 5 GB storage, email support, basic analytics
- Pro Plan: $29.99/month - 100 GB storage, priority support, advanced analytics, API access
- Enterprise Plan: $99.99/month - unlimited storage, 24/7 phone support, custom integrations`;

export function buildSupportRuntime(model: LanguageModel) {
  const wired = wireTools({
    lookupOrder: {
      description: lookupOrder.description ?? 'Look up order status by order ID',
      inputSchema: z.object({ orderId: z.string().describe('The order ID (e.g., ORD-12345)') }),
      execute: async ({ orderId }: { orderId: string }) => ({
        orderId,
        status: 'Shipped',
        estimatedDelivery: '2025-03-10',
        trackingNumber: '1Z999AA1' + Math.random().toString(36).substring(2, 8),
      }),
    },
    getProductInfo: {
      description: getProductInfo.description ?? 'Get information about a product plan',
      inputSchema: z.object({
        planId: z.enum(['basic-plan', 'pro-plan', 'enterprise-plan']).describe('The plan identifier'),
      }),
      execute: async ({ planId }: { planId: keyof typeof PRODUCT_CATALOG }) => {
        const product = PRODUCT_CATALOG[planId];
        return { name: product.name, price: product.price, features: product.features };
      },
    },
    transferToHuman: {
      description: transferToHuman.description ?? 'Transfer the customer to a human agent',
      inputSchema: z.object({ reason: z.string().describe('The reason for transfer') }),
      execute: async ({ reason }: { reason: string }) => ({
        transferred: true,
        reason,
        message: 'Connecting you to a human agent...',
      }),
    },
  });

  const agents = [
    defineAgent({
      id: 'support',
      name: 'Customer Support',
      instructions: supportInstructions,
      model,
      tools: wired.tools,
    }),
  ];

  return createRuntime({
    agents,
    defaultAgentId: 'support',
    defaultModel: model,
    voiceMode: true,
    tools: wired.tools,
  });
}

/**
 * Customer Support Agent Configuration
 */
export const customerSupportAgentConfig = {
  agents: [
    {
      id: 'support',
      name: 'Customer Support',
      prompt: supportInstructions,
    },
  ],
  defaultAgentId: 'support',
};

/**
 * Shared greeting message
 */
export const supportGreeting = 'Hello! Thank you for contacting Acme Inc. Support. How can I help you today?';
