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
import { createPorulleClient, formatLkr, type PorulleClient } from './porulle.js';

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
  return cart.map((l) => [`${l.quantity}×`, l.name, l.strength].filter(Boolean).join(' ')).join(', ');
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

// Catalog tools are factories over the (env-configured) commerce client.
const makeCheckInventoryTool = (commerce: PorulleClient) =>
  defineTool({
  name: 'check_inventory',
  description:
    'Check whether a prescribed medicine (name + optional strength) is in stock. ' +
    'Call once per distinct medicine read from the prescription.',
  input: z.object({
    name: z.string().describe('Medicine name, e.g. "Amoxicillin"'),
    strength: z.string().optional().describe('Strength as written, e.g. "500mg"'),
  }),
  execute: async ({ name, strength }) => {
    const query = [name, strength].filter(Boolean).join(' ').trim();
    const results = await commerce.searchCatalog(query, 6);
    const matched = results.find((p) => p.inStock) ?? results[0] ?? null;
    const toItem = (p: (typeof results)[number]) => ({
      id: p.id, // live catalog id — pass this to add_to_cart
      name: p.title,
      stock: p.stock,
      inStock: p.inStock,
      unitPrice: formatLkr(p.priceAmount),
    });
    return {
      requested: { name, strength },
      inStock: matched?.inStock ?? false,
      item: matched ? toItem(matched) : null,
      alternatives: results
        .filter((p) => p.id !== matched?.id && p.inStock)
        .slice(0, 2)
        .map(toItem),
    };
  },
  });

const makeAddToCartTool = (commerce: PorulleClient) =>
  defineTool({
  name: 'add_to_cart',
  description:
    'Add an in-stock medicine to the cart by name + strength (e.g. "Amoxicillin 500mg"). ' +
    'You do NOT need an id — the tool resolves the product from the live catalog.',
  input: z.object({
    item: z.string().describe('Medicine name + strength, e.g. "Amoxicillin 500mg" (a catalog id also works)'),
    quantity: z.number().int().positive().default(1),
  }),
  execute: async ({ item, quantity }, ctx) => {
    // Resolve by id if it looks like one, else search the catalog by name —
    // so the model can add by name and never has to copy a UUID across turns.
    let found = await commerce.getProduct(item);
    if (!found) {
      const results = await commerce.searchCatalog(item, 5);
      found = results.find((p) => p.inStock) ?? results[0] ?? null;
    }
    if (!found) return { added: false as const, reason: `no catalog match for "${item}"` };
    if (!found.inStock || found.stock <= 0)
      return { added: false as const, reason: `${found.title} is out of stock` };

    const state = ctx!.runState.state as FlowState;
    const now = Date.now();
    const abandoned = reconcileCart(state, now); // stale cart from a previous visit → set aside
    const cart = ensureCart(state);
    const existing = cart.find((l) => l.id === found.id);
    if (existing) existing.quantity += quantity;
    else
      cart.push({
        id: found.id,
        name: found.title,
        strength: '',
        quantity,
        unitPrice: found.priceAmount / 100, // store LKR rupees for display
      });
    state.cartUpdatedAt = now;
    return {
      added: true as const,
      cart,
      total: formatLkr(cartTotal(cart) * 100),
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
    return { removed: true, cart, total: formatLkr(cartTotal(cart) * 100) };
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
      total: formatLkr(cartTotal(cart) * 100),
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
    return { resumed: true as const, cart, total: formatLkr(cartTotal(cart) * 100) };
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
  'Do not narrate your actions or think out loud. NEVER say things like "I will now add this", "let me',
  'check", "just a moment", "one moment please", "I need to check the product details" — just call the',
  'tool silently and reply with the RESULT in one short sentence. Add items by name (e.g. add_to_cart',
  '"Amoxicillin 500mg") — you never need an id. Do not restate the whole cart after every change.',
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
  'Checkout: only when the customer explicitly says they want to pay, ENTER the "checkout" flow (do not',
  'just reply). It returns a secure payment link — the customer pays via that link, then messages you.',
  'When they say they have paid (or ask about their order), call check_payment: tell them the order is',
  'confirmed ONLY if it returns paid:true; if paid:false, say payment is not received yet and to tap the',
  'link. Never claim payment is taken yourself.',
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
  /** Porulle storefront key (kp_sf_…). Required for real checkout; omit to disable it. */
  storefrontKey?: string;
  /** Commerce API base URL (env-configured). Defaults to COMMERCE_API_URL in porulle.ts. */
  commerceBaseUrl?: string;
  /** Inject a commerce client (tests); defaults to a live keyed client. */
  commerce?: PorulleClient;
  // Legacy (unused since checkout moved to Porulle PayHere return-and-check):
  durableObjectId?: string;
  baseUrl?: string;
  payPath?: string;
}

export function buildPharmacyAgent(deps: PharmacyAgentDeps): AgentConfig {
  const { model, storefrontKey } = deps;
  // One env-configured client for catalog + cart/checkout against the live Porulle backend.
  const commerce =
    deps.commerce ?? createPorulleClient({ baseUrl: deps.commerceBaseUrl, apiKey: storefrontKey });
  const checkInventoryTool = makeCheckInventoryTool(commerce);
  const addToCartTool = makeAddToCartTool(commerce);

  // Checkout creates a real order + PayHere pay link, then ENDS (no durable
  // suspend): PayHere notifies the backend, not us, so payment is confirmed by
  // polling confirmPaid() via the check_payment tool when the customer returns.
  const checkout = action({
    id: 'checkout',
    run: async (state, ctx) => {
      const cart = ensureCart(state);
      if (cart.length === 0) {
        emitText(ctx.emit, 'Your cart is empty — add an item before checking out.');
        return { end: 'empty-cart' };
      }
      if (!commerce.hasKey) {
        emitText(ctx.emit, 'Sorry, checkout is temporarily unavailable. Please try again shortly.');
        return { end: 'checkout-unavailable' };
      }
      try {
        const order = await commerce.checkout(
          cart.map((l) => ({ entityId: l.id, quantity: l.quantity })),
        );
        state.pendingOrderId = order.orderId;
        state.pendingOrderNumber = order.orderNumber;
        emitText(
          ctx.emit,
          `Your order ${order.orderNumber}: ${summarizeCart(cart)}. Total ${formatLkr(order.grandTotal)}.\n` +
            `Pay securely here: ${order.payUrl}\n` +
            `Once you've paid, send me a message and I'll confirm your order.`,
        );
        return { end: 'awaiting-payment' };
      } catch {
        emitText(ctx.emit, 'Something went wrong starting your payment. Please try again in a moment.');
        return { end: 'checkout-error' };
      }
    },
  });

  // Polled payment confirmation (PayHere → backend; we verify via the backend).
  const checkPaymentTool = defineTool({
    name: 'check_payment',
    description:
      'Check whether the customer has completed payment for their pending order. Call this when the ' +
      'customer says they have paid, or asks about their order, after a payment link was sent.',
    input: z.object({}),
    execute: async (_args, ctx) => {
      const state = ctx!.runState.state as FlowState;
      const orderId = typeof state.pendingOrderId === 'string' ? state.pendingOrderId : undefined;
      if (!orderId) return { paid: false as const, reason: 'no pending order' };
      const paid = await commerce.confirmPaid(orderId);
      if (!paid) return { paid: false as const, orderNumber: state.pendingOrderNumber };
      const cart = ensureCart(state);
      const orderNumber = (state.pendingOrderNumber as string) ?? orderId;
      const result = { paid: true as const, orderNumber, total: formatLkr(cartTotal(cart) * 100) };
      state.lastOrder = { orderNo: orderNumber, total: cartTotal(cart), lines: cart };
      state.cart = [];
      state.abandonedCart = [];
      state.cartUpdatedAt = undefined;
      state.pendingOrderId = undefined;
      state.pendingOrderNumber = undefined;
      return result;
    },
  });

  const checkoutFlow = defineFlow({
    name: 'checkout',
    description:
      'Take payment for the current cart and confirm the order. Enter this when the customer confirms they want to pay.',
    maxOscillations: 5,
    start: checkout,
    nodes: [checkout],
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
      check_payment: checkPaymentTool,
    },
    flows: [checkoutFlow],
  });
}
