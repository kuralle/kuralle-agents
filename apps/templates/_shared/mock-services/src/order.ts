/**
 * Order tracking service. Ported from Floe's
 * @floe/mock-services/services/order.ts. MCP-mounted there; inline
 * createTool() functions here.
 */
import { z } from 'zod';
import { createTool } from '@kuralle-agents/core';
import { MockStore } from './store.js';

export interface OrderItem {
	sku: string;
	name: string;
	qty: number;
}

export interface Order {
	id: string;
	userId: string;
	items: OrderItem[];
	status: 'pending' | 'in_transit' | 'delivered' | 'issue' | 'canceled';
	trackingUrl: string;
	scheduledArrival: string;
	deliveredAt: string | null;
	issueNote?: string;
}

const SEED: Order[] = [
	{
		id: 'ord_alice_2401',
		userId: 'u_alice',
		items: [
			{ sku: 'MEAL-001', name: 'Forest mushroom risotto kit', qty: 1 },
			{ sku: 'MEAL-002', name: 'Chickpea masala bowl kit', qty: 1 },
		],
		status: 'in_transit',
		trackingUrl: 'https://shipper.example/track/1Z999-2401',
		scheduledArrival: '2026-05-25',
		deliveredAt: null,
	},
	{
		id: 'ord_bob_2310',
		userId: 'u_bob',
		items: [{ sku: 'MEAL-003', name: 'Spring salmon teriyaki kit', qty: 2 }],
		status: 'delivered',
		trackingUrl: 'https://shipper.example/track/1Z999-2310',
		scheduledArrival: '2026-05-22',
		deliveredAt: '2026-05-22T11:34:00Z',
	},
	{
		id: 'ord_bob_2305',
		userId: 'u_bob',
		items: [{ sku: 'MEAL-004', name: 'Roasted chicken sheet-pan kit', qty: 2 }],
		status: 'issue',
		trackingUrl: 'https://shipper.example/track/1Z999-2305',
		scheduledArrival: '2026-05-15',
		deliveredAt: '2026-05-15T14:00:00Z',
		issueNote: 'Customer reports box arrived warm and one kit was leaking.',
	},
];

const store = new MockStore<Order>(SEED);

const lookupOrderSchema = z.object({
	orderId: z.string().min(1),
});
export const lookupOrder = createTool({
	description: 'Get an order by id. REQUIRED arg: `orderId` (e.g. "ord_alice_2401").',
	inputSchema: lookupOrderSchema,
	async execute({ orderId }) {
		const o = store.get(orderId);
		if (!o) return { error: 'order-not-found', orderId };
		return o;
	},
});

const listOrdersSchema = z.object({
	userId: z.string().min(1),
	limit: z.number().int().positive().optional(),
});
export const listOrdersByUser = createTool({
	description:
		'List recent orders for a userId. REQUIRED arg: `userId`. Optional `limit` (default 10). Newest first.',
	inputSchema: listOrdersSchema,
	async execute({ userId, limit }) {
		const u = userId.trim();
		if (!u) return { error: 'userId-missing' };
		const orders = store.list().filter((o) => o.userId === u).slice(0, limit ?? 10);
		return { count: orders.length, orders };
	},
});

const reportIssueSchema = z.object({
	orderId: z.string().min(1),
	issueNote: z.string().min(1),
});
export const reportIssue = createTool({
	description:
		'Mark an order with a customer-reported issue. BOTH args REQUIRED: `orderId`, `issueNote` (short ' +
		'description like "box arrived damaged"). Returns the updated order.',
	inputSchema: reportIssueSchema,
	async execute({ orderId, issueNote }) {
		const o = store.get(orderId);
		if (!o) return { error: 'order-not-found', orderId };
		return store.update(orderId, { status: 'issue', issueNote });
	},
});

export const orderTools = { lookupOrder, listOrdersByUser, reportIssue };
