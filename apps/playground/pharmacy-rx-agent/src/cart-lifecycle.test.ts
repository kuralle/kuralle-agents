import { describe, expect, test } from 'bun:test';
import type { LanguageModel } from 'ai';
import { buildPharmacyAgent } from './pharmacy.js';

// The cart tools never touch the model — a stub is enough to build the agent.
const agent = buildPharmacyAgent({
  model: {} as unknown as LanguageModel,
  durableObjectId: 'whatsapp:PNID:15550001111',
  baseUrl: 'http://localhost',
});

type ToolMap = Record<string, { execute: (args: unknown, ctx: unknown) => Promise<Record<string, unknown>> }>;
const tools = agent.tools as unknown as ToolMap;
const ctxFor = (state: Record<string, unknown>) => ({ runState: { state } });

const HOUR = 60 * 60 * 1000;
const amox = { id: 'amoxicillin-500', name: 'Amoxicillin', strength: '500mg', quantity: 2, unitPrice: 0.45 };

describe('cart lifecycle — abandonment + resume (24h)', () => {
  test('returning after >24h sets the stale cart aside and starts fresh', async () => {
    const state: Record<string, unknown> = { cart: [{ ...amox }], cartUpdatedAt: Date.now() - 25 * HOUR };
    const res = await tools.add_to_cart.execute({ id: 'metformin-500', quantity: 3 }, ctxFor(state));

    expect(res.added).toBe(true);
    // stale Amoxicillin is NOT in the new cart; only the freshly-asked Metformin
    const cart = res.cart as Array<{ id: string }>;
    expect(cart.map((l) => l.id)).toEqual(['metformin-500']);
    // the agent is signalled to offer resume/fresh
    expect(res.returnedAfterGap).toMatchObject({ previousCart: expect.stringContaining('Amoxicillin') });
    // and the old cart is stashed for resume
    expect((state.abandonedCart as unknown[]).length).toBe(1);
  });

  test('returning within 24h keeps the cart (no gap signal)', async () => {
    const state: Record<string, unknown> = { cart: [{ ...amox }], cartUpdatedAt: Date.now() - 1 * HOUR };
    const res = await tools.add_to_cart.execute({ id: 'metformin-500', quantity: 3 }, ctxFor(state));

    expect(res.returnedAfterGap).toBeUndefined();
    const cart = res.cart as Array<{ id: string }>;
    expect(cart.map((l) => l.id).sort()).toEqual(['amoxicillin-500', 'metformin-500']);
  });

  test('resume_cart restores the stashed items', async () => {
    const state: Record<string, unknown> = { cart: [{ ...amox }], cartUpdatedAt: Date.now() - 25 * HOUR };
    await tools.add_to_cart.execute({ id: 'metformin-500', quantity: 3 }, ctxFor(state)); // triggers abandonment
    const res = await tools.resume_cart.execute({}, ctxFor(state));

    expect(res.resumed).toBe(true);
    const cart = res.cart as Array<{ id: string }>;
    expect(cart.map((l) => l.id).sort()).toEqual(['amoxicillin-500', 'metformin-500']);
    expect((state.abandonedCart as unknown[]).length).toBe(0);
  });
});
