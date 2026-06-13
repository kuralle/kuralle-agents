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

function fakeCommerce(opts: { confirmPaid?: boolean; onRegister?: (url: string) => void } = {}): PorulleClient {
  return {
    hasKey: true,
    searchCatalog: async () => [],
    getProduct: async () => null,
    checkout: async () => ({
      orderId: 'o9', orderNumber: 'ORD-9', status: 'pending', grandTotal: 10000, currency: 'LKR',
      payUrl: 'https://checkoutpay/payhere/checkout/o9',
    }),
    confirmPaid: async () => opts.confirmPaid ?? false,
    registerCallback: async (_orderId, url) => {
      opts.onRegister?.(url);
      return true;
    },
  };
}

type Tool = { execute: (a: unknown, c: unknown) => Promise<Record<string, unknown>> };
type Part = { type: string; delta?: string };
const textOf = (parts: Part[]) => parts.filter((p) => p.type === 'text-delta').map((p) => p.delta).join('');

describe('start_checkout tool (LLM-callable, inline — no flow)', () => {
  test('creates the order, registers the callback, and emits the link from run-state cart', async () => {
    let registeredUrl = '';
    const agent = buildPharmacyAgent({
      model: {} as unknown as LanguageModel,
      commerce: fakeCommerce({ onRegister: (u) => (registeredUrl = u) }),
      durableObjectId: 'whatsapp:PID:9477',
      baseUrl: 'https://agent.example',
    });
    const startCheckout = (agent.tools as unknown as Record<string, Tool>).start_checkout;
    const state: Record<string, unknown> = {
      cart: [{ id: 'o9', name: 'Paracetamol 500mg', strength: '', quantity: 20, unitPrice: 5 }],
    };
    const parts: Part[] = [];
    const res = await startCheckout.execute({}, { runState: { state }, emit: (p: Part) => parts.push(p) });

    expect(res).toEqual({ sent: true });
    expect(state.pendingOrderId).toBe('o9');
    expect(state.pendingOrderNumber).toBe('ORD-9');
    expect(registeredUrl).toContain('https://agent.example/payhere-confirmed/');
    const text = textOf(parts);
    expect(text).toContain('ORD-9');
    expect(text).toContain('https://checkoutpay/payhere/checkout/o9');
  });

  test('empty cart → asks to add an item, no order', async () => {
    let registered = false;
    const agent = buildPharmacyAgent({
      model: {} as unknown as LanguageModel,
      commerce: fakeCommerce({ onRegister: () => (registered = true) }),
    });
    const startCheckout = (agent.tools as unknown as Record<string, Tool>).start_checkout;
    const state: Record<string, unknown> = { cart: [] };
    const parts: Part[] = [];
    await startCheckout.execute({}, { runState: { state }, emit: (p: Part) => parts.push(p) });

    expect(textOf(parts).toLowerCase()).toContain('cart is empty');
    expect(state.pendingOrderId).toBeUndefined();
    expect(registered).toBe(false);
  });

  test('the agent has no flows and no check_payment tool (unified deterministic design)', () => {
    const agent = buildPharmacyAgent({ model: {} as unknown as LanguageModel, commerce: fakeCommerce() });
    expect((agent as unknown as { flows?: unknown[] }).flows ?? []).toHaveLength(0);
    expect((agent.tools as Record<string, unknown>).check_payment).toBeUndefined();
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
