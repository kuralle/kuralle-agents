/**
 * Direct HTTP client for the live Porulle + PayHere commerce backend.
 * Replaces the hardcoded inventory + fake /pay link with real catalog, orders,
 * and PayHere checkout. Talks the raw HTTP contract (INTEGRATION.md §4) — no
 * @kuralle-agents/commerce / kit dependency (the agent already has its own cart
 * + flow). Catalog endpoints are public; cart/checkout need the storefront key.
 *
 * Money from the API is integer minor units of LKR (4500 = LKR 45.00).
 */
export const COMMERCE_API_URL = 'https://kualle-porulle-commerce-api.mithushancj.workers.dev';

export interface CatalogProduct {
  id: string;
  slug: string;
  title: string;
  description?: string;
  priceAmount: number; // minor units (LKR cents)
  currency: string; // 'LKR'
  inStock: boolean;
  stock: number;
}

export interface CheckoutResult {
  orderId: string;
  orderNumber: string;
  status: string;
  grandTotal: number; // minor units
  currency: string;
  payUrl: string;
}

export interface PorulleClient {
  searchCatalog(q: string, limit?: number): Promise<CatalogProduct[]>;
  getProduct(id: string): Promise<CatalogProduct | null>;
  /** create cart → add lines → checkout(payhere). Needs the storefront key. */
  checkout(lines: Array<{ entityId: string; quantity: number }>): Promise<CheckoutResult>;
  /** md5sig-verified payment gate — only true once PayHere actually confirmed. */
  confirmPaid(orderId: string): Promise<boolean>;
  readonly hasKey: boolean;
}

export interface PorulleClientConfig {
  baseUrl?: string;
  /** Storefront API key (`kp_sf_…`). Required for cart/checkout, not for catalog. */
  apiKey?: string;
  /** Shipping address sent at checkout (demo default if omitted). */
  shippingAddress?: { line1: string; city: string; postalCode: string; country: string };
}

const DEMO_ADDRESS = { line1: 'N/A', city: 'Colombo', postalCode: '00100', country: 'LK' };

export function createPorulleClient(config: PorulleClientConfig = {}): PorulleClient {
  const baseUrl = (config.baseUrl ?? COMMERCE_API_URL).replace(/\/+$/, '');
  const apiKey = config.apiKey?.trim() || undefined;
  const shippingAddress = config.shippingAddress ?? DEMO_ADDRESS;

  const authHeaders = (): Record<string, string> => {
    if (!apiKey) throw new Error('porulle_no_storefront_key');
    return { authorization: `Bearer ${apiKey}` };
  };

  async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, init);
    if (!res.ok) throw new Error(`porulle ${init?.method ?? 'GET'} ${path} -> ${res.status}`);
    return (await res.json()) as T;
  }

  return {
    hasKey: Boolean(apiKey),

    async searchCatalog(q, limit = 8) {
      const params = new URLSearchParams({ q: q ?? '', limit: String(limit) });
      const { data } = await getJson<{ data: CatalogProduct[] }>(`/agent/catalog?${params}`);
      return data ?? [];
    },

    async getProduct(id) {
      try {
        const { data } = await getJson<{ data: CatalogProduct }>(`/agent/catalog/${id}`);
        return data ?? null;
      } catch {
        return null;
      }
    },

    async checkout(lines) {
      const headers = { 'content-type': 'application/json', ...authHeaders() };
      const cart = await getJson<{ data: { id: string } }>(`/api/carts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ currency: 'LKR' }),
      });
      const cartId = cart.data.id;
      for (const line of lines) {
        await getJson(`/api/carts/${cartId}/items`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ entityId: line.entityId, quantity: line.quantity }),
        });
      }
      const order = await getJson<{
        data: { id: string; orderNumber: string; status: string; grandTotal: number; currency: string };
      }>(`/api/checkout`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ cartId, paymentMethodId: 'payhere', currency: 'LKR', shippingAddress }),
      });
      return {
        orderId: order.data.id,
        orderNumber: order.data.orderNumber,
        status: order.data.status,
        grandTotal: order.data.grandTotal,
        currency: order.data.currency,
        // keyed on the real order id (ignore checkout's pending-order paymentClientSecret).
        payUrl: `${baseUrl}/payhere/checkout/${order.data.id}`,
      };
    },

    async confirmPaid(orderId) {
      try {
        const { paid } = await getJson<{ paid: boolean }>(`/payhere/order-status/${orderId}`);
        return paid === true;
      } catch {
        return false;
      }
    },
  };
}

/** LKR minor units → "LKR 45.00". */
export function formatLkr(minor: number): string {
  return `LKR ${(minor / 100).toFixed(2)}`;
}
