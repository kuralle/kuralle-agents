/**
 * Langfuse tracing demo — multi-agent support + billing (v2).
 */

import { z } from 'zod';
import { defineAgent, type AgentConfig } from '@kuralle-agents/core';
import type { LanguageModel } from 'ai';
import { wireTools } from '@kuralle-playground/shared/runtime/v2Tools';

const getOrderStatus = {
  description: 'Get the current status of an order by order number',
  inputSchema: z.object({ orderNumber: z.string() }),
  execute: async ({ orderNumber }: { orderNumber: string }) => ({
    orderNumber,
    status: 'shipped',
    estimatedDelivery: 'March 5, 2026',
    trackingNumber: '1Z999AA10123456784',
  }),
};

const lookupOrder = {
  description: 'Look up order details by order number or customer email',
  inputSchema: z.object({
    orderNumber: z.string().optional(),
    email: z.string().optional(),
  }),
  execute: async ({ orderNumber }: { orderNumber?: string; email?: string }) => ({
    found: true,
    orderNumber: orderNumber || '12345',
    items: ['Widget Pro', 'Accessory Kit'],
    total: 149.99,
    status: 'delivered',
  }),
};

const createReturn = {
  description: 'Initiate a return request for an order',
  inputSchema: z.object({ orderNumber: z.string(), reason: z.string() }),
  execute: async ({ orderNumber, reason }: { orderNumber: string; reason: string }) => ({
    returnId: 'RET-12345',
    orderNumber,
    reason,
    status: 'approved',
    refundAmount: 149.99,
  }),
};

const getPricing = {
  description: 'Get current pricing for products or services',
  inputSchema: z.object({ productId: z.string().optional() }),
  execute: async () => ({
    basePrice: 149.99,
    currency: 'USD',
    availableDiscounts: ['SAVE20', 'LOYALTY10'],
  }),
};

const applyDiscount = {
  description: 'Apply a discount code to an order',
  inputSchema: z.object({
    discountCode: z.string(),
    orderNumber: z.string().optional(),
  }),
  execute: async ({ discountCode }: { discountCode: string; orderNumber?: string }) => ({
    applied: true,
    discountCode,
    discountPercent: 20,
    savings: 29.99,
  }),
};

const getInvoice = {
  description: 'Retrieve invoice details by invoice number',
  inputSchema: z.object({ invoiceNumber: z.string().optional() }),
  execute: async ({ invoiceNumber }: { invoiceNumber?: string }) => ({
    invoiceNumber: invoiceNumber || 'INV-2026-0201',
    total: 149.99,
    status: 'paid',
    date: '2026-02-01',
  }),
};

export function buildAgents(model: LanguageModel): AgentConfig[] {
  const supportTools = wireTools({ getOrderStatus, lookupOrder, createReturn });
  const billingTools = wireTools({ getPricing, applyDiscount, getInvoice });

  const support = defineAgent({
    id: 'support',
    name: 'Support Agent',
    model,
    instructions:
      'Customer support specialist. Help with orders, shipping, and returns. Explain tool use briefly.',
    tools: supportTools.tools,
    knowledge: {},
  });

  const billing = defineAgent({
    id: 'billing',
    name: 'Billing Agent',
    model,
    instructions:
      'Billing specialist. Help with invoices, payments, pricing, and discounts.',
    tools: billingTools.tools,
    knowledge: {},
  });

  const router = defineAgent({
    id: 'router',
    name: 'Router',
    model,
    instructions: 'Route to support or billing based on the customer question.',
    routes: [
      { agent: 'support', when: 'Orders, shipping, returns, tracking, delivery' },
      { agent: 'billing', when: 'Billing, invoices, payments, pricing, discounts' },
    ],
    routing: { default: 'support', mode: 'structured' },
    agents: [support, billing],
  });

  return [router, support, billing];
}
