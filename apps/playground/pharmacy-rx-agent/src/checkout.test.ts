import { describe, expect, test } from 'bun:test';
import type { LanguageModel } from 'ai';
import { buildPharmacyAgent } from './pharmacy.js';
import type { PorulleClient } from './porulle.js';

// Inject a fake commerce client so the return-and-check (check_payment) logic is
// proven deterministically — independent of the live PayHere sandbox.
function agentWith(confirmPaid: boolean) {
  const fake: PorulleClient = {
    hasKey: true,
    searchCatalog: async () => [],
    getProduct: async () => null,
    checkout: async () => ({
      orderId: 'o1', orderNumber: 'ORD-1', status: 'pending', grandTotal: 4500, currency: 'LKR',
      payUrl: 'https://pay/o1',
    }),
    confirmPaid: async () => confirmPaid,
  };
  return buildPharmacyAgent({ model: {} as unknown as LanguageModel, commerce: fake });
}

type Tool = { execute: (a: unknown, c: unknown) => Promise<Record<string, unknown>> };
const ctxFor = (state: Record<string, unknown>) => ({ runState: { state } });
const pendingState = () => ({
  cart: [{ id: 'o1-item', name: 'Amoxicillin 500mg', strength: '', quantity: 1, unitPrice: 45 }],
  pendingOrderId: 'o1',
  pendingOrderNumber: 'ORD-1',
});

describe('check_payment — return-and-check', () => {
  test('paid:true confirms the order and clears the cart', async () => {
    const check = (agentWith(true).tools as unknown as Record<string, Tool>).check_payment;
    const state = pendingState();
    const res = await check.execute({}, ctxFor(state));

    expect(res.paid).toBe(true);
    expect(res.orderNumber).toBe('ORD-1');
    expect((state.cart as unknown[]).length).toBe(0);
    expect(state.pendingOrderId).toBeUndefined();
    expect(state.lastOrder).toBeDefined();
  });

  test('paid:false leaves the pending order + cart intact', async () => {
    const check = (agentWith(false).tools as unknown as Record<string, Tool>).check_payment;
    const state = pendingState();
    const res = await check.execute({}, ctxFor(state));

    expect(res.paid).toBe(false);
    expect((state.cart as unknown[]).length).toBe(1);
    expect(state.pendingOrderId).toBe('o1');
  });

  test('no pending order → paid:false with reason', async () => {
    const check = (agentWith(true).tools as unknown as Record<string, Tool>).check_payment;
    const res = await check.execute({}, ctxFor({}));
    expect(res).toMatchObject({ paid: false, reason: 'no pending order' });
  });
});
