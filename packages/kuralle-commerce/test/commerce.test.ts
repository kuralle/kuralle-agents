import { describe, expect, it } from 'bun:test';
import type { ToolContext } from '@kuralle-agents/core';
import { createInMemoryCatalog } from '../src/catalog.js';
import { createCartTools, readCart, CART_STATE_KEY } from '../src/cart.js';
import {
  createOrderTool,
  createInMemoryOrderLedger,
  orderContentKey,
} from '../src/order.js';
import { cartTotal, formatMoney, type Product } from '../src/types.js';
import { toWhatsAppProductList } from '../src/whatsapp.js';

const products: Product[] = [
  {
    id: 'p1',
    title: 'Chocolate Cake',
    description: 'Rich dark chocolate cake',
    price: { amount: 4500, currency: 'LKR' },
    retailerId: 'retail-p1',
    stock: 5,
  },
  {
    id: 'p2',
    title: 'Vanilla Cupcake',
    price: { amount: 800, currency: 'LKR' },
    retailerId: 'retail-p2',
  },
  {
    id: 'p3',
    title: 'No Retailer Brownie',
    price: { amount: 1200, currency: 'LKR' },
  },
];

function makeCtx(sessionId = 'sess-1', userId = 'user-1'): ToolContext {
  return {
    session: { id: sessionId, userId } as ToolContext['session'],
    runState: { state: {} } as unknown as ToolContext['runState'],
    tool: async () => null,
    now: async () => Date.now(),
    uuid: async () => 'uuid',
    emit: () => {},
  } as unknown as ToolContext;
}

describe('money', () => {
  it('totals integer minor units and rejects mixed currencies', () => {
    expect(
      cartTotal([
        { productId: 'p1', title: 'x', unitPrice: { amount: 4500, currency: 'LKR' }, quantity: 2 },
        { productId: 'p2', title: 'y', unitPrice: { amount: 800, currency: 'LKR' }, quantity: 1 },
      ]),
    ).toEqual({ amount: 9800, currency: 'LKR' });
    expect(formatMoney({ amount: 9800, currency: 'LKR' })).toBe('98.00 LKR');
    expect(() =>
      cartTotal([
        { productId: 'p1', title: 'x', unitPrice: { amount: 1, currency: 'LKR' }, quantity: 1 },
        { productId: 'p2', title: 'y', unitPrice: { amount: 1, currency: 'USD' }, quantity: 1 },
      ]),
    ).toThrow('Mixed currencies');
  });
});

describe('cart tools', () => {
  const tools = createCartTools({ catalog: createInMemoryCatalog(products) });

  it('product_search finds products by keyword', async () => {
    const result = (await tools.product_search!.execute({ query: 'chocolate cake' }, makeCtx())) as {
      products: Product[];
      count: number;
    };
    // "cake" also substring-matches "Cupcake"; the exact match ranks first
    expect(result.count).toBe(2);
    expect(result.products[0]?.id).toBe('p1');
  });

  it('cart_add / cart_remove / cart_view round-trip through run state', async () => {
    const ctx = makeCtx();
    await tools.cart_add!.execute({ productId: 'p1', quantity: 2 }, ctx);
    const after = (await tools.cart_add!.execute({ productId: 'p2', quantity: 1 }, ctx)) as {
      itemCount: number;
      totalFormatted: string | null;
    };
    expect(after.itemCount).toBe(3);
    expect(after.totalFormatted).toBe('98.00 LKR');

    // merged duplicate lines
    await tools.cart_add!.execute({ productId: 'p1', quantity: 1 }, ctx);
    expect(readCart(ctx).items.find((i) => i.productId === 'p1')?.quantity).toBe(3);

    const removed = (await tools.cart_remove!.execute({ productId: 'p1', quantity: null }, ctx)) as {
      itemCount: number;
    };
    expect(removed.itemCount).toBe(1);

    const view = (await tools.cart_view!.execute({}, ctx)) as { itemCount: number };
    expect(view.itemCount).toBe(1);
    // cart lives in flow state under the well-known key
    expect(ctx.runState.state[CART_STATE_KEY]).toBeDefined();
  });

  it('cart_add returns structured errors for unknown product and stock', async () => {
    const ctx = makeCtx();
    expect(await tools.cart_add!.execute({ productId: 'nope', quantity: 1 }, ctx)).toEqual({
      error: 'product_not_found',
      productId: 'nope',
    });
    expect(await tools.cart_add!.execute({ productId: 'p1', quantity: 99 }, ctx)).toEqual({
      error: 'insufficient_stock',
      productId: 'p1',
      available: 5,
    });
  });
});

describe('create_order idempotency', () => {
  const catalog = createInMemoryCatalog(products);

  async function ctxWithCart(sessionId: string) {
    const tools = createCartTools({ catalog });
    const ctx = makeCtx(sessionId);
    await tools.cart_add!.execute({ productId: 'p1', quantity: 2 }, ctx);
    return ctx;
  }

  it('submits once, returns the same order on identical resubmission, clears the cart', async () => {
    let submissions = 0;
    const order = createOrderTool({
      submit: async () => {
        submissions += 1;
        return { orderId: `ord-${submissions}` };
      },
    });

    const ctx = await ctxWithCart('idem-sess');
    const first = (await order.execute({ note: null }, ctx)) as { order: { id: string } };
    expect(first.order.id).toBe('ord-1');
    expect(readCart(ctx).items).toHaveLength(0);

    // user re-adds the identical cart and asks again
    const ctx2 = await ctxWithCart('idem-sess');
    const second = (await order.execute({ note: null }, ctx2)) as { order: { id: string } };
    expect(second.order.id).toBe('ord-1');
    expect(submissions).toBe(1);
  });

  it('coalesces concurrent submissions of the same cart', async () => {
    let submissions = 0;
    const order = createOrderTool({
      submit: async () => {
        submissions += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { orderId: 'ord-x' };
      },
    });
    const ctxA = await ctxWithCart('conc-sess');
    const ctxB = await ctxWithCart('conc-sess');
    const [a, b] = (await Promise.all([
      order.execute({ note: null }, ctxA),
      order.execute({ note: null }, ctxB),
    ])) as Array<{ order: { id: string } }>;
    expect(a.order.id).toBe('ord-x');
    expect(b.order.id).toBe('ord-x');
    expect(submissions).toBe(1);
  });

  it('different sessions or different carts produce different orders', async () => {
    const itemsA = [
      { productId: 'p1', title: 'x', unitPrice: { amount: 1, currency: 'LKR' }, quantity: 1 },
    ];
    const keyS1 = await orderContentKey('s1', itemsA);
    expect(keyS1).not.toBe(await orderContentKey('s2', itemsA));
    expect(keyS1).not.toBe(await orderContentKey('s1', [{ ...itemsA[0]!, quantity: 2 }]));
  });

  it('refuses an empty cart with a structured error', async () => {
    const order = createOrderTool({ submit: async () => ({ orderId: 'never' }) });
    expect(await order.execute({ note: null }, makeCtx('empty-sess'))).toEqual({
      error: 'cart_empty',
    });
  });

  it('a shared ledger dedupes across tool instances', async () => {
    const ledger = createInMemoryOrderLedger();
    let submissions = 0;
    const make = () =>
      createOrderTool({
        ledger,
        submit: async () => {
          submissions += 1;
          return { orderId: `ord-${submissions}` };
        },
      });
    const first = (await make().execute({ note: null }, await ctxWithCart('ledger-sess'))) as {
      order: { id: string };
    };
    const second = (await make().execute({ note: null }, await ctxWithCart('ledger-sess'))) as {
      order: { id: string };
    };
    expect(first.order.id).toBe('ord-1');
    expect(second.order.id).toBe('ord-1');
    expect(submissions).toBe(1);
  });
});

describe('toWhatsAppProductList', () => {
  it('maps products with retailer ids and skips the rest', () => {
    const payload = toWhatsAppProductList(products, {
      catalogId: 'cat-1',
      header: 'Our cakes',
      body: 'Pick a favourite',
      sectionTitle: 'Cakes',
    });
    expect(payload).toEqual({
      catalogId: 'cat-1',
      header: 'Our cakes',
      body: 'Pick a favourite',
      footer: undefined,
      sections: [{ title: 'Cakes', productRetailerIds: ['retail-p1', 'retail-p2'] }],
    });
  });
});
