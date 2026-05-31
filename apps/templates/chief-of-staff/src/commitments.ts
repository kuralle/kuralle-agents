/**
 * Inline commitments tool — chief-of-staff specific. The Floe original
 * used a custom MCP server (defineMockService); here we just inline
 * the same shape as a small set of createTool() functions.
 */
import { z } from 'zod';
import { createTool } from '@kuralle-agents/core';
import { MockStore } from '@kuralle-templates/_shared-mock-services';

export interface Commitment {
	id: string;
	what: string;
	to: string;
	dueDate: string;
	status: 'open' | 'in_progress' | 'done' | 'dropped';
	loggedAt: string;
	notes: string;
}

const SEED: Commitment[] = [
	{ id: 'cmt_001', what: 'Send Q3 priorities deck', to: 'board', dueDate: '2026-05-30', status: 'in_progress', loggedAt: '2026-05-20T10:00:00Z', notes: 'Slides 1-4 done; numbers section pending finance review.' },
	{ id: 'cmt_002', what: 'Reply to Acme partnership term sheet', to: 'eve@acme.example', dueDate: '2026-05-28', status: 'open', loggedAt: '2026-05-22T14:00:00Z', notes: '' },
	{ id: 'cmt_003', what: 'Schedule 1:1 with Bob about retention plan', to: 'bob@acme.example', dueDate: '2026-05-27', status: 'open', loggedAt: '2026-05-23T09:30:00Z', notes: '' },
	{ id: 'cmt_004', what: 'Send Q2 board update', to: 'board', dueDate: '2026-04-15', status: 'done', loggedAt: '2026-04-01T08:00:00Z', notes: 'Sent on time; positive reception.' },
];

const store = new MockStore<Commitment>(SEED);

function nextId(): string {
	const nums = store.list().filter((c) => c.id.startsWith('cmt_')).map((c) => parseInt(c.id.slice(4), 10)).filter((n) => !isNaN(n));
	const next = (nums.length === 0 ? 0 : Math.max(...nums)) + 1;
	return `cmt_${String(next).padStart(3, '0')}`;
}

const listSchema = z.object({
	status: z.enum(['open', 'in_progress', 'done', 'dropped']).optional(),
	to: z.string().optional(),
	overdueOnly: z.boolean().optional(),
	upcomingWithinDays: z.number().int().positive().optional(),
});
export const listCommitments = createTool({
	description: 'List commitments. All filters optional: `status`, `to`, `overdueOnly`, `upcomingWithinDays`.',
	inputSchema: listSchema,
	async execute({ status, to, overdueOnly, upcomingWithinDays }) {
		const now = Date.now();
		const day = 86_400_000;
		const hits = store.list().filter((c) => {
			if (status && c.status !== status) return false;
			if (to && c.to !== to) return false;
			if (overdueOnly && Date.parse(c.dueDate) >= now) return false;
			if (upcomingWithinDays && (Date.parse(c.dueDate) - now) > upcomingWithinDays * day) return false;
			return true;
		}).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
		return { count: hits.length, commitments: hits };
	},
});

const idSchema = z.object({ id: z.string().min(1) });
export const getCommitment = createTool({
	description: 'Fetch a commitment by id. REQUIRED arg: `id`.',
	inputSchema: idSchema,
	async execute({ id }) {
		const c = store.get(id);
		return c ?? { error: 'commitment-not-found', id };
	},
});

const logSchema = z.object({
	what: z.string().min(1),
	to: z.string().min(1),
	dueDate: z.string().min(1),
	notes: z.string().optional(),
});
export const logCommitment = createTool({
	description: 'Log a new commitment the leader made. REQUIRED args: `what`, `to`, `dueDate` (YYYY-MM-DD). Optional `notes`. Returns the created commitment.',
	inputSchema: logSchema,
	async execute({ what, to, dueDate, notes }) {
		const id = nextId();
		const cmt: Commitment = {
			id,
			what,
			to,
			dueDate,
			status: 'open',
			loggedAt: new Date().toISOString(),
			notes: notes ?? '',
		};
		(store as any).map.set(id, cmt);
		return cmt;
	},
});

const updateSchema = z.object({
	id: z.string().min(1),
	status: z.enum(['open', 'in_progress', 'done', 'dropped']),
});
export const updateCommitmentStatus = createTool({
	description: 'Update a commitment status. BOTH args REQUIRED: `id`, `status`.',
	inputSchema: updateSchema,
	async execute({ id, status }) {
		const c = store.get(id);
		if (!c) return { error: 'commitment-not-found', id };
		return store.update(id, { status });
	},
});

export const commitmentsTools = { listCommitments, getCommitment, logCommitment, updateCommitmentStatus };
