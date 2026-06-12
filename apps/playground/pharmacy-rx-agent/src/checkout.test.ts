import { describe, expect, test } from 'bun:test';
import type { LanguageModel } from 'ai';
import { DURABLE_RUNS_KEY, type Session, type SessionStore } from '@kuralle-agents/core';
import {
  buildPharmacyAgent,
  isCheckoutIntent,
  performCheckout,
  finalizeConfirmedOrder,
} from './pharmacy.js';
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
    registerCallback: async () => true,
  };
  return buildPharmacyAgent({ model: {} as unknown as LanguageModel, commerce: fake });
}

type Tool = { execute: (a: unknown, c: unknown) => Promise<Record<string, unknown>> };
const ctxFor = (state: Record<string, unknown>) => ({ runState: { state } });

type ActionNode = { id: string; run: (state: Record<string, unknown>, ctx: unknown) => Promise<unknown> };
type Part = { type: string; delta?: string };
const nodeOf = (agent: ReturnType<typeof agentWith>, id: string): ActionNode =>
  (agent.flows as unknown as Array<{ nodes: ActionNode[] }>)[0]!.nodes.find((n) => n.id === id)!;
const textOf = (parts: Part[]) => parts.filter((p) => p.type === 'text-delta').map((p) => p.delta).join('');
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

describe('checkout flow — durable suspend + deterministic confirm', () => {
  // The checkout action creates the order, registers the confirm-callback, emits
  // the pay link, then suspends on the payment signal. We stub ctx.signal to throw
  // a sentinel so run() stops at the suspend, then assert the pre-suspend effects.
  class Suspended extends Error {}

  function checkoutCtx(parts: Part[]) {
    return {
      emit: (p: Part) => parts.push(p),
      uuid: async () => 'sig-1',
      signal: async () => {
        throw new Suspended();
      },
      now: () => new Date(),
    };
  }

  test('first pass creates order, registers callback, emits link, suspends', async () => {
    const parts: Part[] = [];
    
    let registeredUrl = '';
    const fake: PorulleClient = {
      hasKey: true,
      searchCatalog: async () => [],
      getProduct: async () => null,
      checkout: async () => ({
        orderId: 'o1', orderNumber: 'ORD-9', status: 'pending', grandTotal: 10000, currency: 'LKR',
        payUrl: 'https://pay/o1',
      }),
      confirmPaid: async () => false,
      registerCallback: async (_orderId, url) => {
        registeredUrl = url;
        return true;
      },
    };
    const agent = buildPharmacyAgent({
      model: {} as unknown as LanguageModel,
      commerce: fake,
      durableObjectId: 'whatsapp:PID:9477',
      baseUrl: 'https://agent.example',
    });
    const checkout = nodeOf(agent, 'checkout');
    const state: Record<string, unknown> = {
      cart: [{ id: 'o1', name: 'Paracetamol 500mg', strength: '', quantity: 20, unitPrice: 5 }],
    };

    await expect(checkout.run(state, checkoutCtx(parts))).rejects.toThrow(Suspended);

    expect(state.pendingOrderId).toBe('o1');
    expect(state.pendingOrderNumber).toBe('ORD-9');
    expect(state.paymentLinkSent).toBe(true);
    // callback routes back to THIS DO + signal via the default receiver path.
    expect(registeredUrl).toContain('https://agent.example/payhere-confirmed/');
    const text = textOf(parts);
    expect(text).toContain('ORD-9');
    expect(text).toContain('https://pay/o1');
  });

  test('orderComplete confirms + clears cart only when paid', async () => {
    const agent = agentWith(true);
    const orderComplete = nodeOf(agent, 'orderComplete');
    const parts: Part[] = [];
    const state: Record<string, unknown> = {
      cart: [{ id: 'o1', name: 'Paracetamol 500mg', strength: '', quantity: 20, unitPrice: 5 }],
      pendingOrderId: 'o1',
      pendingOrderNumber: 'ORD-1',
      paymentLinkSent: true,
    };

    await orderComplete.run(state, { emit: (p: Part) => parts.push(p) });

    expect(textOf(parts)).toContain('✅');
    expect(textOf(parts)).toContain('ORD-1');
    expect((state.cart as unknown[]).length).toBe(0);
    expect(state.pendingOrderId).toBeUndefined();
    expect(state.paymentLinkSent).toBe(false);
    expect(state.lastOrder).toBeDefined();
  });

  test('orderComplete does NOT confirm when payment is unverified (forgery gate)', async () => {
    const agent = agentWith(false);
    const orderComplete = nodeOf(agent, 'orderComplete');
    const parts: Part[] = [];
    const state: Record<string, unknown> = {
      cart: [{ id: 'o1', name: 'Paracetamol 500mg', strength: '', quantity: 20, unitPrice: 5 }],
      pendingOrderId: 'o1',
      pendingOrderNumber: 'ORD-1',
    };

    await orderComplete.run(state, { emit: (p: Part) => parts.push(p) });

    expect(textOf(parts)).not.toContain('✅');
    expect((state.cart as unknown[]).length).toBe(1);
    expect(state.pendingOrderId).toBe('o1');
  });
});

describe('deterministic checkout (model-independent)', () => {
  test('isCheckoutIntent recognizes clear pay/checkout commands only', () => {
    for (const t of ['checkout', 'Checkout', 'pay now', 'i want to pay', "i'd like to checkout", 'proceed to pay', 'complete my order'])
      expect(isCheckoutIntent(t)).toBe(true);
    for (const t of ['hi', 'add 2 paracetamol', 'do you have metformin?', 'thanks', undefined])
      expect(isCheckoutIntent(t)).toBe(false);
  });

  const SID = 'whatsapp:PID:9477';
  function storeWith(cart: unknown[]): { store: SessionStore; saved: () => Session | null } {
    let session: Session = {
      id: SID, conversationId: SID, channelId: 'whatsapp', createdAt: new Date(), updatedAt: new Date(),
      messages: [], workingMemory: {}, currentAgent: 'pharmacy', agentStates: {}, handoffHistory: [],
      [DURABLE_RUNS_KEY]: { [SID]: { runState: { runId: SID, state: { cart } }, steps: [] } },
    } as unknown as Session;
    return {
      store: {
        get: async () => session,
        save: async (s: Session) => { session = s; },
        delete: async () => {},
        list: async () => [session],
      },
      saved: () => session,
    };
  }
  const commerceFake = (paid: boolean): PorulleClient => ({
    hasKey: true, searchCatalog: async () => [], getProduct: async () => null,
    checkout: async () => ({ orderId: 'o9', orderNumber: 'ORD-9', status: 'pending', grandTotal: 10000, currency: 'LKR', payUrl: 'https://checkoutpay/payhere/checkout/o9' }),
    confirmPaid: async () => paid, registerCallback: async () => true,
  });

  test('performCheckout creates the order + returns the link from cart in run state', async () => {
    const { store } = storeWith([{ id: 'o9', name: 'Paracetamol 500mg', strength: '', quantity: 20, unitPrice: 5 }]);
    const text = await performCheckout({ sessionStore: store, sessionId: SID, commerce: commerceFake(false), durableObjectId: SID, baseUrl: 'https://agent', payPath: '/payhere-confirmed/' });
    expect(text).toContain('ORD-9');
    expect(text).toContain('https://checkoutpay/payhere/checkout/o9');
  });

  test('performCheckout on an empty cart asks to add an item', async () => {
    const { store } = storeWith([]);
    const text = await performCheckout({ sessionStore: store, sessionId: SID, commerce: commerceFake(false), durableObjectId: SID, baseUrl: 'https://agent', payPath: '/payhere-confirmed/' });
    expect(text.toLowerCase()).toContain('cart is empty');
  });

  const stateOf = (s: Session | null): { cart: unknown[]; pendingOrderId?: string } =>
    (s as unknown as Record<string, Record<string, { runState: { state: { cart: unknown[]; pendingOrderId?: string } } }>>)[
      DURABLE_RUNS_KEY as unknown as string
    ][SID].runState.state;

  test('finalizeConfirmedOrder confirms + clears cart only when paid', async () => {
    const cart = [{ id: 'o9', name: 'Paracetamol 500mg', strength: '', quantity: 20, unitPrice: 5 }];
    const { store, saved } = storeWith(cart);
    stateOf(saved()).pendingOrderId = 'o9';

    const ok = await finalizeConfirmedOrder({ sessionStore: store, sessionId: SID, commerce: commerceFake(true) });
    expect(ok.paid).toBe(true);
    expect(ok.text).toContain('✅');
    expect(stateOf(saved()).cart.length).toBe(0);
    expect(stateOf(saved()).pendingOrderId).toBeUndefined();
  });

  test('finalizeConfirmedOrder stays silent when not actually paid (forgery gate)', async () => {
    const { store, saved } = storeWith([{ id: 'o9', name: 'Paracetamol 500mg', strength: '', quantity: 20, unitPrice: 5 }]);
    stateOf(saved()).pendingOrderId = 'o9';
    const ok = await finalizeConfirmedOrder({ sessionStore: store, sessionId: SID, commerce: commerceFake(false) });
    expect(ok.paid).toBe(false);
    expect(ok.text).toBe('');
    expect(stateOf(saved()).cart.length).toBe(1); // cart untouched
  });
});
