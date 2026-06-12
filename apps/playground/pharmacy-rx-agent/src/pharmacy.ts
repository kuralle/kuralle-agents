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

/** Cart is considered abandoned after this gap of inactivity (matches the WhatsApp 24h window). */
const CART_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Cart lifecycle: if the customer returns after >24h with an unpaid cart, set
 * those items aside (`abandonedCart`) and start them fresh — the agent then
 * offers to resume or keep the fresh start. Returns the stashed items (if any)
 * so the calling tool can signal `returnedAfterGap` to the model.
 */
function reconcileCart(state: FlowState, now: number): CartLine[] | null {
  const cart = ensureCart(state);
  const updatedAt = typeof state.cartUpdatedAt === 'number' ? (state.cartUpdatedAt as number) : undefined;
  if (cart.length > 0 && updatedAt !== undefined && now - updatedAt > CART_TTL_MS) {
    state.abandonedCart = cart;
    state.cart = [];
    return cart;
  }
  return null;
}

function summarizeCart(cart: CartLine[]): string {
  return cart.map((l) => `${l.quantity}× ${l.name} ${l.strength}`).join(', ');
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
    const now = Date.now();
    const abandoned = reconcileCart(state, now); // stale cart from a previous visit → set aside
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
    state.cartUpdatedAt = now;
    return {
      added: true as const,
      cart,
      total: cartTotal(cart),
      ...(abandoned ? { returnedAfterGap: { previousCart: summarizeCart(abandoned) } } : {}),
    };
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
    state.cartUpdatedAt = Date.now();
    return { removed: true, cart, total: cartTotal(cart) };
  },
});

const viewCartTool = defineTool({
  name: 'view_cart',
  description: 'Return the current cart and its total.',
  input: z.object({}),
  execute: async (_args, ctx) => {
    const state = ctx!.runState.state as FlowState;
    const abandoned = reconcileCart(state, Date.now()); // expire a stale cart on return
    const cart = ensureCart(state);
    return {
      cart,
      total: cartTotal(cart),
      ...(abandoned ? { returnedAfterGap: { previousCart: summarizeCart(abandoned) } } : {}),
    };
  },
});

const resumeCartTool = defineTool({
  name: 'resume_cart',
  description:
    'Restore the items the customer had before they stepped away (call only after they confirm ' +
    'they want to resume that earlier cart).',
  input: z.object({}),
  execute: async (_args, ctx) => {
    const state = ctx!.runState.state as FlowState;
    const previous = Array.isArray(state.abandonedCart) ? (state.abandonedCart as CartLine[]) : [];
    if (previous.length === 0) return { resumed: false as const, reason: 'nothing to resume' };
    const cart = ensureCart(state);
    for (const line of previous) {
      const existing = cart.find((l) => l.id === line.id);
      if (existing) existing.quantity += line.quantity;
      else cart.push(line);
    }
    state.abandonedCart = [];
    state.cartUpdatedAt = Date.now();
    return { resumed: true as const, cart, total: cartTotal(cart) };
  },
});

// ---------------------------------------------------------------------------
// Checkout flow — entered by the model (enter_flow) when the customer confirms
// payment. The conversation itself (intake / inventory / cart / Q&A) is the
// answering surface above; this flow is the durable, suspendable payment step.
// ---------------------------------------------------------------------------

const INSTRUCTIONS = [
  'You are a friendly pharmacy ordering assistant on a WhatsApp-style chat. Keep replies short and',
  'natural — this is a quick chat, not an email. A line or two is usually plenty.',
  '',
  'Prescriptions: when the customer sends a prescription image, read it and identify each medicine and',
  'strength. Call check_inventory for each, then tell the customer briefly what is available and the',
  'price. Say simply "in stock" or "out of stock" — never mention internal stock counts or inventory ids.',
  '',
  'Out of stock: mention it once and offer at most ONE alternative. If the customer is not interested,',
  'let it go — do not keep proposing more options or pushing a sale.',
  '',
  'Do not narrate your actions. Never say "I will now add this to your cart" or "I will generate a',
  'payment link" — just call the tool; the customer sees the result. Do not restate the whole cart after',
  'every change unless asked.',
  '',
  'Add ONLY the exact medicines the customer names in their CURRENT message. Never add an item just',
  'because it appeared earlier in the chat or in a previous order — that is not part of this request.',
  'Use add_to_cart only when they clearly ask to buy or add a specific medicine. Treat greetings and',
  'closings ("hi", "thanks", "thank you", "ok", "bye") as conversation, not commands: reply warmly in',
  'one line and do NOT add anything to the cart or start checkout.',
  '',
  'Trust the tools, not your memory: what view_cart / add_to_cart return IS the cart. Never reconstruct',
  'the cart from the conversation, and do not re-check or re-offer medicines the customer has not asked',
  'about in their current message.',
  '',
  'Checkout: only when the customer explicitly says they want to pay for the current cart, ENTER the',
  '"checkout" flow (do not just reply). It issues the payment link and confirms the order after payment.',
  'Never claim payment is taken yourself.',
  '',
  'A confirmed order is CLOSED — it has been paid and dispatched, and everything above that',
  'confirmation is history. The cart for any new request starts EMPTY. When the customer messages again',
  '(even just "thanks"), greet them and help with their NEW request only; never re-add, re-quote, or',
  're-run items from a finished order unless they explicitly ask for them again.',
  '',
  'Returning customers: if a cart tool result includes "returnedAfterGap", the customer stepped away',
  'for more than a day and their old unpaid cart was set aside. Greet them, say what was in it, and ask',
  'whether to resume that cart (call resume_cart) or keep the fresh start — do not assume.',
].join('\n');

export interface PharmacyAgentDeps {
  model: LanguageModel;
  durableObjectId: string;
  baseUrl: string;
  /** Path prefix for the payment callback link. Web DO uses `/pay/`; WhatsApp uses `/wa-pay/`. */
  payPath?: string;
}

export function buildPharmacyAgent(deps: PharmacyAgentDeps): AgentConfig {
  const { model, durableObjectId, baseUrl, payPath = '/pay/' } = deps;

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
      state.abandonedCart = [];
      state.cartUpdatedAt = undefined;
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
      const link = `${baseUrl}${payPath}${token}`;

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
      resume_cart: resumeCartTool,
    },
    flows: [checkoutFlow],
  });
}
