/**
 * Channel-agnostic conversational-commerce primitives.
 *
 * Money is integer minor units (cents) — never floats. Tools return data
 * only (Kuralle design rule); rendering carts/products into channel messages
 * is the messaging layer's job (see `toWhatsAppProductList`).
 */

export interface Money {
  /** Integer amount in minor units (e.g. cents). */
  amount: number;
  /** ISO 4217 currency code, e.g. 'USD', 'LKR'. */
  currency: string;
}

export interface Product {
  id: string;
  title: string;
  description?: string;
  price: Money;
  /** Channel catalog id (e.g. Meta Commerce Manager `product_retailer_id`). */
  retailerId?: string;
  imageUrl?: string;
  /** Available stock; undefined = not tracked. */
  stock?: number;
  metadata?: Record<string, unknown>;
}

export interface CartItem {
  productId: string;
  title: string;
  unitPrice: Money;
  quantity: number;
  retailerId?: string;
}

export interface Cart {
  items: CartItem[];
  updatedAt: string;
}

export type OrderStatus = 'created' | 'confirmed' | 'fulfilled' | 'cancelled';

export interface Order {
  id: string;
  sessionId: string;
  userId?: string;
  items: CartItem[];
  total: Money;
  status: OrderStatus;
  /** Stable content key the order was deduplicated on. */
  contentKey: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

/**
 * Host-implemented product source (your commerce backend / MCP server /
 * product API). Tools never invent products — they read this.
 */
export interface ProductCatalog {
  get(productId: string): Promise<Product | null>;
  search(query: string, opts?: { limit?: number }): Promise<Product[]>;
}

export function cartTotal(items: CartItem[]): Money {
  if (items.length === 0) {
    return { amount: 0, currency: 'USD' };
  }
  const currency = items[0]!.unitPrice.currency;
  let amount = 0;
  for (const item of items) {
    if (item.unitPrice.currency !== currency) {
      throw new Error(
        `Mixed currencies in cart: ${currency} and ${item.unitPrice.currency}`,
      );
    }
    amount += item.unitPrice.amount * item.quantity;
  }
  return { amount, currency };
}

export function formatMoney(money: Money): string {
  return `${(money.amount / 100).toFixed(2)} ${money.currency}`;
}
