import { describe, expect, it } from 'bun:test';
import type { LanguageModel } from 'ai';
import type { ToolContext } from '@kuralle-agents/core';
import { createInMemoryOrderLedger } from '@kuralle-agents/commerce';
import { buildCommerceAgent } from '../src/agent.js';

const env = {
  CLOUDFLARE_API_KEY: 'gateway-token',
  CLOUDFLARE_ACCOUNT_ID: 'account',
  CLOUDFLARE_GATEWAY_ID: 'gateway',
  SAMESAKE_API_KEY: 'search-key',
  PORULLE_URL: 'https://commerce.example',
  PORULLE_STOREFRONT_KEY: 'store-key',
  STRIPE_PAYMENT_METHOD_TOKEN: 'pm_card_visa',
  ENVIRONMENT: 'test',
};

function context(): ToolContext {
  return {
    session: { id: 'session-1', userId: 'shopper-1' },
    runState: { state: {} },
    tool: async () => null,
    now: async () => Date.now(),
    uuid: async () => crypto.randomUUID(),
    emit: () => undefined,
  } as unknown as ToolContext;
}

describe('agentic commerce composition', () => {
  it('converts a user-facing USD budget to minor units before retrieval', async () => {
    let requestedMaxPrice: number | undefined;
    const agent = buildCommerceAgent({
      model: {} as LanguageModel,
      env,
      ledger: createInMemoryOrderLedger(),
      retrieval: {
        find: async (request: { maxPrice?: number }) => {
          requestedMaxPrice = request.maxPrice;
          return { products: [], took_ms: 1 };
        },
        getIndexed: async () => null,
      } as never,
      porulle: {
        async getProduct() { return null; },
        async checkout() { throw new Error('not called'); },
      },
    });

    await agent.tools!.find_products!.execute({
      intent: 'weatherproof bag',
      maxPrice: 100,
      currency: 'USD',
      inStock: true,
      strict: true,
      limit: 2,
    }, context());

    expect(requestedMaxPrice).toBe(10_000);
  });

  it('keeps discovery in Samesake but revalidates cart lines through Porulle', async () => {
    let authoritativeReads = 0;
    const agent = buildCommerceAgent({
      model: {} as LanguageModel,
      env,
      ledger: createInMemoryOrderLedger(),
      retrieval: {
        find: async () => ({ products: [], took_ms: 1 }),
        getIndexed: async () => null,
      } as never,
      porulle: {
        async getProduct(id) {
          authoritativeReads += 1;
          return { id, title: 'Authoritative bag', price: { amount: 9900, currency: 'USD' }, stock: 2 };
        },
        async checkout() {
          return { orderId: 'order-1', status: 'created', total: { amount: 9900, currency: 'USD' } };
        },
      },
    });

    const result = await agent.tools!.cart_add!.execute({ productId: 'bag-1', quantity: 1 }, context());
    expect(authoritativeReads).toBe(1);
    expect(result).toMatchObject({ itemCount: 1, totalFormatted: '99.00 USD' });
    expect(agent.tools!.create_order!.needsApproval).toBe(true);
  });
});
