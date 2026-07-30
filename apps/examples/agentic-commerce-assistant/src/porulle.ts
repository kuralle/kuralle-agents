import type { Money, Product } from '@kuralle-agents/commerce';

export interface PorulleCheckoutResult {
  orderId: string;
  orderNumber?: string;
  status: string;
  total: Money;
  paymentIntentId?: string;
}

export interface PorulleClient {
  getProduct(id: string): Promise<Product | null>;
  checkout(args: {
    items: Array<{ productId: string; quantity: number }>;
    idempotencyKey: string;
    paymentMethodToken: string;
  }): Promise<PorulleCheckoutResult>;
}

interface AgentProduct {
  id: string;
  title: string;
  description?: string;
  priceAmount: number;
  currency: string;
  stock: number;
  imageUrl?: string;
}

export function createPorulleClient(options: { baseUrl: string; apiKey: string }): PorulleClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const headers = {
    authorization: `Bearer ${options.apiKey}`,
    'content-type': 'application/json',
  };

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const requestHeaders = new Headers(headers);
    new Headers(init?.headers).forEach((value, key) => requestHeaders.set(key, value));
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: requestHeaders,
    });
    if (!response.ok) {
      const requestId = response.headers.get('x-request-id');
      throw new Error(`Porulle ${init?.method ?? 'GET'} ${path} failed (${response.status})${requestId ? ` request=${requestId}` : ''}`);
    }
    return (await response.json()) as T;
  }

  return {
    async getProduct(id) {
      try {
        const response = await request<{ data: AgentProduct }>(`/agent/catalog/${encodeURIComponent(id)}`);
        const value = response.data;
        return {
          id: value.id,
          title: value.title,
          description: value.description,
          price: { amount: value.priceAmount, currency: value.currency },
          stock: value.stock,
          imageUrl: value.imageUrl,
        };
      } catch {
        return null;
      }
    },

    async checkout(args) {
      const cart = await request<{ data: { id: string } }>('/api/carts', {
        method: 'POST',
        body: JSON.stringify({ currency: 'USD' }),
      });
      for (const item of args.items) {
        await request(`/api/carts/${encodeURIComponent(cart.data.id)}/items`, {
          method: 'POST',
          body: JSON.stringify({ entityId: item.productId, quantity: item.quantity }),
        });
      }
      const response = await request<{
        data: {
          id: string;
          orderNumber?: string;
          status: string;
          grandTotal: number;
          currency: string;
          paymentIntentId?: string;
        };
      }>('/api/checkout', {
        method: 'POST',
        headers: { 'idempotency-key': args.idempotencyKey },
        body: JSON.stringify({
          cartId: cart.data.id,
          paymentMethodId: 'stripe',
          paymentMethodToken: args.paymentMethodToken,
          idempotencyKey: args.idempotencyKey,
          currency: 'USD',
          shippingAddress: {
            line1: 'Agentic commerce sandbox',
            city: 'San Francisco',
            postalCode: '94107',
            country: 'US',
          },
        }),
      });
      return {
        orderId: response.data.id,
        orderNumber: response.data.orderNumber,
        status: response.data.status,
        total: { amount: response.data.grandTotal, currency: response.data.currency },
        paymentIntentId: response.data.paymentIntentId,
      };
    },
  };
}
