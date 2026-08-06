import { z } from 'zod';
import type { LanguageModel } from 'ai';
import { defineAgent, defineTool } from '@kuralle-agents/core';
import {
  createCartTools,
  createOrderTool,
  formatMoney,
  type OrderLedger,
} from '@kuralle-agents/commerce';
import type { CommerceEnv } from './env.js';
import type { PorulleClient } from './porulle.js';
import type { ProductRetrieval } from './search.js';
import { createRetrievalLedCatalog } from './search.js';

export interface BuildCommerceAgentOptions {
  model: LanguageModel;
  env: CommerceEnv;
  retrieval: ProductRetrieval;
  porulle: PorulleClient;
  ledger: OrderLedger;
}

export function buildCommerceAgent(options: BuildCommerceAgentOptions) {
  const catalog = createRetrievalLedCatalog(options.retrieval, (id) => options.porulle.getProduct(id));
  const cart = createCartTools({ catalog });

  const findProducts = defineTool({
    name: 'find_products',
    description:
      'Grounded hybrid retrieval over the product catalog. Use first for every recommendation or product-finding request. Only populate maxPrice, brand, or category when the user explicitly stated that constraint; leave them absent rather than inferring them from a product name.',
    input: z.object({
      intent: z.string().min(1),
      maxPrice: z.number().nonnegative().optional().describe('Maximum price in user-facing USD, for example 100 for $100'),
      currency: z.literal('USD').default('USD'),
      brand: z.string().optional().describe('Exact required brand, only when explicitly stated by the user'),
      category: z.string().optional().describe('Exact required category, only when explicitly stated by the user'),
      inStock: z.boolean().default(true),
      strict: z.boolean().default(true).describe('Exclude candidates whose required facts are unknown'),
      limit: z.number().int().min(1).max(12).default(6),
    }),
    replay: false,
    parallelSafe: true,
    timeoutMs: 20_000,
    execute: async (request) => {
      const result = await options.retrieval.find({
        ...request,
        maxPrice: request.maxPrice == null ? undefined : Math.round(request.maxPrice * 100),
        explain: true,
      });
      return {
        products: result.products.map((product) => ({
          id: product.id,
          title: product.title,
          price: product.price,
          priceDisplay: product.price
            ? formatMoney({ amount: product.price.amount, currency: product.price.currency ?? request.currency })
            : undefined,
          availability: product.availability,
          verification: product.verification,
          grounding: product.grounding,
          why: product.why,
        })),
        parsedIntent: result.parsed,
        constraintTrace: result.constraintTrace,
        relaxed: result.relaxed,
      };
    },
  });

  const createOrder = createOrderTool({
    ledger: options.ledger,
    needsApproval: true,
    submit: async ({ items, contentKey }) => {
      const paymentMethodToken = options.env.STRIPE_PAYMENT_METHOD_TOKEN?.trim();
      if (!paymentMethodToken) {
        throw new Error('checkout_payment_method_missing');
      }
      if (options.env.ENVIRONMENT === 'production' && paymentMethodToken === 'pm_card_visa') {
        throw new Error('Stripe test payment methods are disabled in production');
      }
      const checkout = await options.porulle.checkout({
        items: items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
        idempotencyKey: contentKey,
        paymentMethodToken,
      });
      return {
        orderId: checkout.orderId,
        metadata: {
          orderNumber: checkout.orderNumber,
          status: checkout.status,
          total: formatMoney(checkout.total),
        },
      };
    },
  });

  return defineAgent({
    id: 'shopping-assistant',
    name: 'Kuralle Shopping Assistant',
    description: 'Retrieval-led shopping, cart management, and approval-gated Porulle checkout.',
    model: options.model,
    controlModel: options.model,
    instructions: `You are a concise shopping assistant grounded in the live catalog.

For every discovery, recommendation, comparison, substitute, budget, brand, or availability request, call find_products before answering. Its maxPrice input is user-facing USD (100 means $100); conversion to cents is deterministic inside the tool. Only send maxPrice, brand, or category when the user explicitly stated that constraint. Never infer a category from a product name or invent a budget. Treat candidates as discovery evidence, not commercial truth. State when strict constraints eliminate all results; never quietly relax a budget, stock, brand, safety, or blocked-attribute constraint.

Use exact product ids returned by retrieval when calling cart_add. cart_add revalidates price and stock against Porulle. Never claim that an item was added, removed, ordered, paid, or reserved unless the relevant tool result confirms it. Use cart_view before checkout and summarize exact lines and total. create_order is consequential and will pause for explicit human approval. Do not describe the order as placed until the resumed tool returns an order id.

Never ask for or repeat raw card numbers, security codes, passwords, or API tokens. Payment instruments must be tokenized outside the model. Keep ordinary answers under 120 words and ask one focused question at a time.`,
    tools: {
      find_products: findProducts,
      product_search: cart.product_search!,
      cart_add: cart.cart_add!,
      cart_remove: cart.cart_remove!,
      cart_view: cart.cart_view!,
      create_order: createOrder,
    },
    limits: {
      maxTurns: 50,
      maxSteps: 24,
      toolMaxSteps: 16,
      maxOscillations: 3,
      maxToolConcurrency: 2,
    },
  });
}
