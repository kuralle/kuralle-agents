import { afterEach, describe, expect, it } from 'bun:test';
import { createPorulleClient } from '../src/porulle.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('Porulle checkout adapter', () => {
  it('passes the content key and tokenized Stripe payment method to server-priced checkout', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/api/carts')) return Response.json({ data: { id: 'cart-1' } });
      if (url.includes('/items')) return Response.json({ data: { id: 'line-1' } });
      return Response.json({
        data: { id: 'order-1', status: 'paid', grandTotal: 2500, currency: 'USD', paymentIntentId: 'pi_1' },
      });
    }) as typeof fetch;

    const result = await createPorulleClient({ baseUrl: 'https://commerce.example', apiKey: 'store-key' }).checkout({
      items: [{ productId: 'product-1', quantity: 2 }],
      idempotencyKey: 'content-key-1',
      paymentMethodToken: 'pm_card_visa',
    });

    const checkout = calls.at(-1)!;
    const body = JSON.parse(String(checkout.init?.body));
    expect(new Headers(checkout.init?.headers).get('idempotency-key')).toBe('content-key-1');
    expect(body).toMatchObject({
      paymentMethodId: 'stripe',
      paymentMethodToken: 'pm_card_visa',
      idempotencyKey: 'content-key-1',
    });
    expect(result).toMatchObject({ orderId: 'order-1', paymentIntentId: 'pi_1' });
  });
});
