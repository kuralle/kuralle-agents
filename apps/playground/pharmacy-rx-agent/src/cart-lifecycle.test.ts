import { describe, expect, test } from 'bun:test';
import type { LanguageModel } from 'ai';
import { buildPharmacyAgent } from './pharmacy.js';

// The cart-lifecycle tools (view_cart / resume_cart) never touch the model or the
// network — a stub model is enough, and we drive them with hand-built state so the
// 24h abandonment logic is tested offline (no live catalog calls).
const agent = buildPharmacyAgent({
  model: {} as unknown as LanguageModel,
  durableObjectId: 'whatsapp:PNID:15550001111',
  baseUrl: 'http://localhost',
});

type Tool = { execute: (args: unknown, ctx: unknown) => Promise<Record<string, unknown>> };
const viewCart = (agent.globalTools as unknown as Record<string, Tool>).view_cart;
const resumeCart = (agent.tools as unknown as Record<string, Tool>).resume_cart;
const ctxFor = (state: Record<string, unknown>) => ({ runState: { state } });

const HOUR = 60 * 60 * 1000;
const amox = { id: 'amox-uuid', name: 'Amoxicillin 500mg', strength: '', quantity: 2, unitPrice: 45 };

describe('cart lifecycle — abandonment + resume (24h)', () => {
  test('returning after >24h sets the stale cart aside and starts fresh', async () => {
    const state: Record<string, unknown> = { cart: [{ ...amox }], cartUpdatedAt: Date.now() - 25 * HOUR };
    const res = await viewCart.execute({}, ctxFor(state));

    expect((res.cart as unknown[]).length).toBe(0); // live cart cleared
    expect(res.returnedAfterGap).toMatchObject({ previousCart: expect.stringContaining('Amoxicillin') });
    expect((state.abandonedCart as unknown[]).length).toBe(1); // stashed for resume
  });

  test('returning within 24h keeps the cart (no gap signal)', async () => {
    const state: Record<string, unknown> = { cart: [{ ...amox }], cartUpdatedAt: Date.now() - 1 * HOUR };
    const res = await viewCart.execute({}, ctxFor(state));

    expect(res.returnedAfterGap).toBeUndefined();
    expect((res.cart as unknown[]).length).toBe(1);
  });

  test('resume_cart restores the stashed items', async () => {
    const state: Record<string, unknown> = { cart: [{ ...amox }], cartUpdatedAt: Date.now() - 25 * HOUR };
    await viewCart.execute({}, ctxFor(state)); // triggers abandonment → stash
    const res = await resumeCart.execute({}, ctxFor(state));

    expect(res.resumed).toBe(true);
    expect((res.cart as Array<{ id: string }>).map((l) => l.id)).toEqual(['amox-uuid']);
    expect((state.abandonedCart as unknown[]).length).toBe(0);
  });
});
