import { z } from 'zod';
import type { LanguageModel } from 'ai';
import {
  action,
  defineAgent,
  defineFlow,
  defineTool,
  type FlowState,
  type HarnessStreamPart,
  type AgentConfig,
} from '@kuralle-agents/core';
import { matchInventory, INVENTORY } from './inventory.js';
import { encodeCheckoutToken, PAYMENT_SIGNAL } from './token.js';

// ---------------------------------------------------------------------------
// Cart (persisted in flow/session state → DO SQLite via BridgeSessionStore)
// ---------------------------------------------------------------------------

export interface CartLine {
  id: string;
  name: string;
  strength: string;
  quantity: number;
  unitPrice: number;
}

function ensureCart(state: FlowState): CartLine[] {
  if (!Array.isArray(state.cart)) state.cart = [];
  return state.cart as CartLine[];
}

function cartTotal(cart: CartLine[]): number {
  return Number(cart.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0).toFixed(2));
}

function emitText(emit: (part: HarnessStreamPart) => void, text: string): void {
  const id = crypto.randomUUID();
  emit({ type: 'text-start', id });
  emit({ type: 'text-delta', id, delta: text });
  emit({ type: 'text-end', id });
}

// ---------------------------------------------------------------------------
// Global tools (model-visible + durable in the answering turn — ADR 0001).
// These mutate the persisted cart in run state.
// ---------------------------------------------------------------------------

const checkInventoryTool = defineTool({
  name: 'check_inventory',
  description:
    'Check whether a prescribed medicine (name + optional strength) is in stock. ' +
    'Call once per distinct medicine read from the prescription.',
  input: z.object({
    name: z.string().describe('Medicine name, e.g. "Amoxicillin"'),
    strength: z.string().optional().describe('Strength as written, e.g. "500mg"'),
  }),
  execute: async ({ name, strength }) => {
    const m = matchInventory(name, strength);
    return {
      requested: { name, strength },
      inStock: m.inStock,
      item: m.matched
        ? {
            id: m.matched.id,
            name: m.matched.name,
            strength: m.matched.strength,
            stock: m.matched.stock,
            unitPrice: m.matched.price,
            rxRequired: m.matched.rxRequired,
          }
        : null,
      alternatives: m.alternatives.map((a) => ({
        id: a.id,
        name: a.name,
        strength: a.strength,
        unitPrice: a.price,
      })),
    };
  },
});

const addToCartTool = defineTool({
  name: 'add_to_cart',
  description: 'Add an in-stock medicine to the cart by its inventory id.',
  input: z.object({
    id: z.string().describe('Inventory id from check_inventory (e.g. "amoxicillin-500")'),
    quantity: z.number().int().positive().default(1),
  }),
  execute: async ({ id, quantity }, ctx) => {
    const found = INVENTORY.find((it) => it.id === id) ?? null;
    if (!found) return { added: false as const, reason: 'unknown item id' };
    if (found.stock <= 0) return { added: false as const, reason: 'out of stock' };

    const state = ctx!.runState.state as FlowState;
    const cart = ensureCart(state);
    const existing = cart.find((l) => l.id === found.id);
    if (existing) existing.quantity += quantity;
    else
      cart.push({
        id: found.id,
        name: found.name,
        strength: found.strength,
        quantity,
        unitPrice: found.price,
      });
    return { added: true as const, cart, total: cartTotal(cart) };
  },
});

const removeFromCartTool = defineTool({
  name: 'remove_from_cart',
  description: 'Remove a medicine from the cart by its inventory id.',
  input: z.object({ id: z.string() }),
  execute: async ({ id }, ctx) => {
    const state = ctx!.runState.state as FlowState;
    const cart = ensureCart(state).filter((l) => l.id !== id);
    state.cart = cart;
    return { removed: true, cart, total: cartTotal(cart) };
  },
});

const viewCartTool = defineTool({
  name: 'view_cart',
  description: 'Return the current cart and its total.',
  input: z.object({}),
  execute: async (_args, ctx) => {
    const cart = ensureCart(ctx!.runState.state as FlowState);
    return { cart, total: cartTotal(cart) };
  },
});

// ---------------------------------------------------------------------------
// Checkout flow — entered by the model (enter_flow) when the customer confirms
// payment. The conversation itself (intake / inventory / cart / Q&A) is the
// answering surface above; this flow is the durable, suspendable payment step.
// ---------------------------------------------------------------------------

const INSTRUCTIONS = [
  'You are a pharmacy ordering assistant on a WhatsApp-style chat.',
  'When the customer sends a prescription image, READ it and identify each medicine and strength.',
  'For each medicine, call check_inventory and tell the customer what is in stock, what is out of',
  'stock (offer an in-stock alternative strength if available), and the unit price.',
  'Add items with add_to_cart; manage the cart with remove_from_cart / view_cart. Answer questions naturally.',
  'When — and only when — the customer explicitly confirms they want to pay for the current cart,',
  'ENTER the "checkout" flow (do not just reply). The checkout flow issues the payment link and',
  'confirms the order after payment. Never claim payment is taken yourself.',
].join(' ');

export interface PharmacyAgentDeps {
  model: LanguageModel;
  durableObjectId: string;
  baseUrl: string;
}

export function buildPharmacyAgent(deps: PharmacyAgentDeps): AgentConfig {
  const { model, durableObjectId, baseUrl } = deps;

  const orderComplete = action({
    id: 'orderComplete',
    run: async (state, ctx) => {
      const cart = ensureCart(state);
      const total = cartTotal(cart);
      const orderNo = `RX-${(await ctx.uuid()).slice(0, 8).toUpperCase()}`;
      emitText(
        ctx.emit,
        `✅ Payment received — order ${orderNo} ($${total}) is confirmed and will be dispatched. Thank you!`,
      );
      state.lastOrder = { orderNo, total, lines: cart };
      state.cart = [];
      state.paymentLinkSent = false;
      return { end: 'ordered' };
    },
  });

  const checkout = action({
    id: 'checkout',
    run: async (state, ctx) => {
      const cart = ensureCart(state);
      if (cart.length === 0) {
        emitText(ctx.emit, 'Your cart is empty — add an item before checking out.');
        return { end: 'empty-cart' };
      }

      // ctx.uuid() is a durable effect — called UNCONDITIONALLY so the callsite
      // order is identical on the first pass and the post-payment replay (else the
      // recorded signal step key would not match and the run would re-suspend).
      const signalId = await ctx.uuid();
      const token = encodeCheckoutToken({ doId: durableObjectId, signalId });
      const link = `${baseUrl}/pay/${token}`;

      // Emit the link once; `paymentLinkSent` is persisted before the suspend, so
      // the post-payment replay skips this (no double-send).
      if (!state.paymentLinkSent) {
        const total = cartTotal(cart);
        const summary = cart.map((l) => `${l.quantity}× ${l.name} ${l.strength}`).join(', ');
        emitText(
          ctx.emit,
          `Your order: ${summary}. Total $${total}. Pay securely to confirm: ${link}`,
        );
        state.paymentLinkSent = true;
      }

      // Suspend until /pay delivers the durable `payment` signal.
      await ctx.signal(PAYMENT_SIGNAL);
      return orderComplete;
    },
  });

  const checkoutFlow = defineFlow({
    name: 'checkout',
    description:
      'Take payment for the current cart and confirm the order. Enter this when the customer confirms they want to pay.',
    maxOscillations: 5,
    start: checkout,
    nodes: [checkout, orderComplete],
  });

  return defineAgent({
    id: 'pharmacy',
    name: 'Pharmacy Rx Agent',
    instructions: INSTRUCTIONS,
    model,
    // Read-only lookups may be globally visible (incl. mid-flow Q&A)…
    globalTools: {
      check_inventory: checkInventoryTool,
      view_cart: viewCartTool,
    },
    // …but mutating tools stay out of globalTools (ADR 0001 allow-list rule):
    // `tools` are still model-callable in answering turns, just not mid-flow.
    tools: {
      add_to_cart: addToCartTool,
      remove_from_cart: removeFromCartTool,
    },
    flows: [checkoutFlow],
  });
}
