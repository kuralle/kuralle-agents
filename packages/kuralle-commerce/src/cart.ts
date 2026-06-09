import { z } from 'zod';
import { defineTool } from '@kuralle-agents/core';
import type { AnyTool, ToolContext } from '@kuralle-agents/core';
import { cartTotal, formatMoney } from './types.js';
import type { Cart, CartItem, ProductCatalog } from './types.js';

/** Durable home of the cart: flow state, persisted by the runtime at turn boundaries. */
export const CART_STATE_KEY = '__cart';

function requireCtx(ctx?: ToolContext): ToolContext {
  if (!ctx?.runState) {
    throw new Error('cart tools require a run context (runState)');
  }
  return ctx;
}

export function readCart(ctx: ToolContext): Cart {
  const raw = ctx.runState.state[CART_STATE_KEY];
  if (raw && typeof raw === 'object' && Array.isArray((raw as Cart).items)) {
    return raw as Cart;
  }
  return { items: [], updatedAt: new Date(0).toISOString() };
}

export function writeCart(ctx: ToolContext, items: CartItem[]): Cart {
  const cart: Cart = { items, updatedAt: new Date().toISOString() };
  ctx.runState.state[CART_STATE_KEY] = cart;
  return cart;
}

export function clearCart(ctx: ToolContext): void {
  delete ctx.runState.state[CART_STATE_KEY];
}

function cartSummary(cart: Cart) {
  return {
    items: cart.items,
    itemCount: cart.items.reduce((sum, item) => sum + item.quantity, 0),
    total: cart.items.length > 0 ? cartTotal(cart.items) : null,
    totalFormatted: cart.items.length > 0 ? formatMoney(cartTotal(cart.items)) : null,
  };
}

const addInput = z.object({
  productId: z.string().describe('Product id from the catalog (use product_search first)'),
  quantity: z.number().int().min(1).default(1),
});

const removeInput = z.object({
  productId: z.string(),
  quantity: z
    .union([z.number().int().min(1), z.null()])
    .describe('How many to remove; null removes the line entirely'),
});

const searchInput = z.object({
  query: z.string().describe('What the user is looking for, e.g. "chocolate cake"'),
});

export interface CartToolsOptions {
  catalog: ProductCatalog;
}

/**
 * Durable cart + catalog tools. Data-only returns (rendering is the channel
 * layer's job). `product_search` and `cart_view` are safe for `globalTools`;
 * keep `cart_add`/`cart_remove` flow-gated or model-visible per your design.
 */
export function createCartTools(options: CartToolsOptions): Record<string, AnyTool> {
  const { catalog } = options;

  const product_search = defineTool({
    name: 'product_search',
    description: 'Search the product catalog. Returns matching products with ids and prices.',
    input: searchInput,
    execute: async (args) => {
      const products = await catalog.search(args.query);
      return { products, count: products.length };
    },
  });

  const cart_add = defineTool({
    name: 'cart_add',
    description: 'Add a product to the cart by product id.',
    input: addInput,
    execute: async (args, ctx) => {
      const toolCtx = requireCtx(ctx);
      const product = await catalog.get(args.productId);
      if (!product) {
        return { error: 'product_not_found', productId: args.productId };
      }
      if (product.stock !== undefined && product.stock < args.quantity) {
        return { error: 'insufficient_stock', productId: args.productId, available: product.stock };
      }
      const cart = readCart(toolCtx);
      const existing = cart.items.find((item) => item.productId === args.productId);
      const items = existing
        ? cart.items.map((item) =>
            item.productId === args.productId
              ? { ...item, quantity: item.quantity + args.quantity }
              : item,
          )
        : [
            ...cart.items,
            {
              productId: product.id,
              title: product.title,
              unitPrice: product.price,
              quantity: args.quantity,
              retailerId: product.retailerId,
            },
          ];
      return cartSummary(writeCart(toolCtx, items));
    },
  });

  const cart_remove = defineTool({
    name: 'cart_remove',
    description: 'Remove a product (or reduce its quantity) from the cart.',
    input: removeInput,
    execute: async (args, ctx) => {
      const toolCtx = requireCtx(ctx);
      const cart = readCart(toolCtx);
      const items = cart.items.flatMap((item) => {
        if (item.productId !== args.productId) return [item];
        if (args.quantity == null || args.quantity >= item.quantity) return [];
        return [{ ...item, quantity: item.quantity - args.quantity }];
      });
      return cartSummary(writeCart(toolCtx, items));
    },
  });

  const cart_view = defineTool({
    name: 'cart_view',
    description: 'View the current cart contents and total.',
    input: z.object({}),
    execute: async (_args, ctx) => cartSummary(readCart(requireCtx(ctx))),
  });

  return { product_search, cart_add, cart_remove, cart_view };
}
