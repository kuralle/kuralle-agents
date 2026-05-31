/**
 * Subscription service (meal-kit). Ported from Floe's
 * @floe/mock-services/services/subscription.ts. MCP-mounted there;
 * inline createTool() functions here. Same data shape, same operations.
 *
 * Seed (mirrors floe/packages/mock-services/seeds/subscription.json).
 * Production swap path: replace the seed + each tool body with a real
 * subscription API client.
 */
import { z } from 'zod';
import { createTool } from '@kuralle-agents/core';
import { MockStore } from './store.js';

export interface Subscription {
	id: string;
	userId: string;
	email: string;
	plan: string;
	pricePerWeek: number;
	status: 'active' | 'paused' | 'canceled';
	nextDeliveryDate: string | null;
	skippedWeeks: string[];
	address: string;
	deliveryWindow: string;
	lastChargedAt: string;
	preferences: { spice: 'mild' | 'medium' | 'hot'; allergens: string[]; dietary: string[] };
}

const SEED: Subscription[] = [
	{
		id: 'sub_alice_001',
		userId: 'u_alice',
		email: 'alice@example.com',
		plan: 'family-4',
		pricePerWeek: 84,
		status: 'active',
		nextDeliveryDate: '2026-05-30',
		skippedWeeks: [],
		address: '123 Maple Ave, San Francisco, CA 94110',
		deliveryWindow: 'Sat 8a-12p',
		lastChargedAt: '2026-05-23T05:00:00Z',
		preferences: { spice: 'mild', allergens: ['peanut'], dietary: ['vegetarian'] },
	},
	{
		id: 'sub_bob_002',
		userId: 'u_bob',
		email: 'bob@example.com',
		plan: 'couples-3',
		pricePerWeek: 56,
		status: 'active',
		nextDeliveryDate: '2026-05-29',
		skippedWeeks: ['2026-05-15'],
		address: '57 Oak St, Brooklyn, NY 11215',
		deliveryWindow: 'Fri 4p-8p',
		lastChargedAt: '2026-05-22T05:00:00Z',
		preferences: { spice: 'medium', allergens: [], dietary: [] },
	},
	{
		id: 'sub_carol_003',
		userId: 'u_carol',
		email: 'carol@example.com',
		plan: 'single-2',
		pricePerWeek: 42,
		status: 'paused',
		nextDeliveryDate: null,
		skippedWeeks: [],
		address: '9 Elm Pl, Austin, TX 78704',
		deliveryWindow: 'Sun 9a-1p',
		lastChargedAt: '2026-04-15T05:00:00Z',
		preferences: { spice: 'hot', allergens: ['shellfish'], dietary: [] },
	},
];

const store = new MockStore<Subscription>(SEED);

// ─── Tools ─────────────────────────────────────────────────────────

const lookupSubscriptionSchema = z.object({
	email: z.string().min(1).optional(),
	userId: z.string().min(1).optional(),
});
export const lookupSubscription = createTool({
	description:
		'Find a subscription by email OR userId. At least one is REQUIRED — never call with both empty. ' +
		'Returns the full subscription record (id, plan, status, next delivery, skipped weeks, address, ' +
		'preferences, tenure-indicating lastChargedAt) or null when no match.',
	inputSchema: lookupSubscriptionSchema,
	async execute({ email, userId }) {
		const e = email?.trim();
		const u = userId?.trim();
		if (!e && !u) return { error: 'identifier-missing', hint: 'Re-invoke with email or userId.' };
		if (e) {
			const hit = store.find((s) => s.email.toLowerCase() === e.toLowerCase());
			if (hit) return hit;
		}
		if (u) {
			const hit = store.find((s) => s.userId === u);
			if (hit) return hit;
		}
		return { error: 'subscription-not-found', email, userId };
	},
});

const skipWeekSchema = z.object({
	subscriptionId: z.string().min(1),
	weekStartDate: z.string().min(1).describe('YYYY-MM-DD'),
});
export const skipWeek = createTool({
	description:
		'Skip a specific delivery week (YYYY-MM-DD). REQUIRED args: `subscriptionId`, `weekStartDate`. ' +
		'Returns {ok, savings, subscription} or {error: "already_skipped"} if that week was already skipped.',
	inputSchema: skipWeekSchema,
	async execute({ subscriptionId, weekStartDate }) {
		const sub = store.get(subscriptionId);
		if (!sub) return { error: 'unknown_subscription', subscriptionId };
		if (sub.skippedWeeks.includes(weekStartDate)) {
			return { error: 'already_skipped', weekStartDate };
		}
		const updated = store.update(subscriptionId, {
			skippedWeeks: [...sub.skippedWeeks, weekStartDate],
		});
		return { ok: true, savings: sub.pricePerWeek, subscription: updated };
	},
});

const subscriptionIdOnlySchema = z.object({
	subscriptionId: z.string().min(1),
});
export const pauseSubscription = createTool({
	description: 'Pause a subscription indefinitely. Clears nextDeliveryDate. REQUIRED arg: `subscriptionId`.',
	inputSchema: subscriptionIdOnlySchema,
	async execute({ subscriptionId }) {
		const sub = store.get(subscriptionId);
		if (!sub) return { error: 'unknown_subscription', subscriptionId };
		return store.update(subscriptionId, { status: 'paused', nextDeliveryDate: null });
	},
});

const cancelSchema = z.object({
	subscriptionId: z.string().min(1),
	reason: z.string().optional(),
});
export const cancelSubscription = createTool({
	description:
		'Cancel a subscription. REQUIRED arg: `subscriptionId`. Optional `reason` for retention analytics.',
	inputSchema: cancelSchema,
	async execute({ subscriptionId }) {
		const sub = store.get(subscriptionId);
		if (!sub) return { error: 'unknown_subscription', subscriptionId };
		return store.update(subscriptionId, { status: 'canceled', nextDeliveryDate: null });
	},
});

const updateAddressSchema = z.object({
	subscriptionId: z.string().min(1),
	address: z.string().min(1),
});
export const updateAddress = createTool({
	description: 'Change the delivery address. BOTH args REQUIRED: `subscriptionId`, `address`.',
	inputSchema: updateAddressSchema,
	async execute({ subscriptionId, address }) {
		const sub = store.get(subscriptionId);
		if (!sub) return { error: 'unknown_subscription', subscriptionId };
		return store.update(subscriptionId, { address });
	},
});

const issueRefundSchema = z.object({
	subscriptionId: z.string().min(1),
	amountUsd: z.number().positive(),
	reason: z.string().min(1),
});
export const issueRefund = createTool({
	description:
		'Issue a refund for a past delivery. ALL THREE args REQUIRED: `subscriptionId`, `amountUsd` (positive number), ' +
		'`reason` (short string). Returns a refund id + amount. (Mock always succeeds.) Per-template policy ' +
		'rules (e.g. cap at $50 without escalation) belong in the calling agent prompt, NOT here.',
	inputSchema: issueRefundSchema,
	async execute({ subscriptionId, amountUsd, reason }) {
		const sub = store.get(subscriptionId);
		if (!sub) return { error: 'unknown_subscription', subscriptionId };
		return {
			ok: true,
			refundId: `ref_${Math.random().toString(36).slice(2, 10)}`,
			amountUsd,
			reason,
			subscriptionId,
		};
	},
});

export const subscriptionTools = {
	lookupSubscription,
	skipWeek,
	pauseSubscription,
	cancelSubscription,
	updateAddress,
	issueRefund,
};
