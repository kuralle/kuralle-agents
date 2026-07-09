import { z } from 'zod';
import { defineTool } from '@kuralle-agents/core';
import type { AnyTool, ToolContext } from '@kuralle-agents/core';
import { cartTotal } from './types.js';
import type { CartItem, Order } from './types.js';
import { clearCart, readCart } from './cart.js';

/**
 * Idempotent order creation.
 *
 * Two dedupe layers, because the durable effect log only covers replays of
 * the SAME tool call — it cannot stop a fresh "place my order" turn from
 * submitting the identical cart twice:
 *
 *   1. Content key: stable hash of (sessionId + sorted cart lines). The
 *      ledger maps content key → order; an identical resubmission returns
 *      the existing order instead of re-submitting.
 *   2. In-flight coalescing: concurrent submissions of the same content key
 *      share one `submit` promise.
 */
export interface OrderLedger {
  get(contentKey: string): Promise<Order | null>;
  /** Store the order for its content key; first write wins. Returns the stored order. */
  putIfAbsent(contentKey: string, order: Order): Promise<Order>;
}

export function createInMemoryOrderLedger(): OrderLedger {
  const orders = new Map<string, Order>();
  return {
    async get(contentKey) {
      return orders.get(contentKey) ?? null;
    },
    async putIfAbsent(contentKey, order) {
      const existing = orders.get(contentKey);
      if (existing) return existing;
      orders.set(contentKey, order);
      return order;
    },
  };
}

export async function orderContentKey(sessionId: string, items: CartItem[]): Promise<string> {
  const lines = items
    .map((item) => `${item.productId}x${item.quantity}@${item.unitPrice.amount}${item.unitPrice.currency}`)
    .sort()
    .join('|');
  // Web Crypto (global) — works on workerd without nodejs_compat, unlike node:crypto.
  const data = new TextEncoder().encode(`${sessionId}::${lines}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export interface SubmitOrderArgs {
  sessionId: string;
  userId?: string;
  items: CartItem[];
  total: ReturnType<typeof cartTotal>;
  contentKey: string;
  note?: string;
}

export interface CreateOrderToolOptions {
  /** Host order submission (your backend / payment flow). Must return the order id. */
  submit: (args: SubmitOrderArgs) => Promise<{ orderId: string; metadata?: Record<string, unknown> }>;
  /** Cross-turn dedupe ledger. Default: in-memory (single process — use a durable ledger in production). */
  ledger?: OrderLedger;
}

const createOrderInput = z.object({
  note: z.union([z.string(), z.null()]).describe('Optional order note from the user'),
});

/**
 * Durable, idempotent `create_order` tool. Reads the cart from flow state,
 * refuses empty carts, dedupes identical resubmissions via the content-key
 * ledger, coalesces concurrent submissions, and clears the cart on success.
 * Returns order data only — confirmation wording is the flow's job.
 */
export function createOrderTool(options: CreateOrderToolOptions): AnyTool {
  const ledger = options.ledger ?? createInMemoryOrderLedger();
  const inFlight = new Map<string, Promise<Order>>();

  async function submitOnce(ctx: ToolContext, note?: string): Promise<Order> {
    const cart = readCart(ctx);
    if (cart.items.length === 0) {
      throw new Error('cart_empty');
    }
    const sessionId = ctx.session.id;
    const contentKey = await orderContentKey(sessionId, cart.items);

    const existing = await ledger.get(contentKey);
    if (existing) {
      return existing;
    }

    const pending = inFlight.get(contentKey);
    if (pending) {
      return pending;
    }

    const submission = (async () => {
      const total = cartTotal(cart.items);
      const result = await options.submit({
        sessionId,
        userId: ctx.session.userId,
        items: cart.items,
        total,
        contentKey,
        note,
      });
      const order: Order = {
        id: result.orderId,
        sessionId,
        userId: ctx.session.userId,
        items: cart.items,
        total,
        status: 'created',
        contentKey,
        createdAt: new Date().toISOString(),
        metadata: result.metadata,
      };
      const stored = await ledger.putIfAbsent(contentKey, order);
      if (stored.id === order.id) {
        clearCart(ctx);
      }
      return stored;
    })();

    inFlight.set(contentKey, submission);
    try {
      return await submission;
    } finally {
      inFlight.delete(contentKey);
    }
  }

  return defineTool({
    name: 'create_order',
    description:
      'Place the order for the current cart. Idempotent: resubmitting the same cart returns the existing order instead of ordering twice.',
    input: createOrderInput,
    execute: async (args, ctx) => {
      if (!ctx?.runState) {
        throw new Error('create_order requires a run context (runState)');
      }
      try {
        const order = await submitOnce(ctx, args.note ?? undefined);
        return { order };
      } catch (error) {
        if (error instanceof Error && error.message === 'cart_empty') {
          return { error: 'cart_empty' };
        }
        throw error;
      }
    },
  });
}
