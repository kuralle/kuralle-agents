/**
 * Linear-shaped ticket tracker mock.
 */
import { z } from 'zod';
import { createTool } from '@kuralle-agents/core';
import { MockStore } from './store.js';

export type LinearState = 'todo' | 'in_progress' | 'in_review' | 'done' | 'canceled';
export type LinearPriority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

export interface LinearComment {
	author: string;
	at: string;
	body: string;
}

export interface LinearIssue {
	id: string;
	project: string;
	title: string;
	description: string;
	state: LinearState;
	priority: LinearPriority;
	assignee: string | null;
	requester: string;
	createdAt: string;
	updatedAt: string;
	comments: LinearComment[];
}

const SEED: LinearIssue[] = [
	{ id: 'LIN-101', project: 'IT', title: 'MacBook keyboard replacement for u_dave', description: 'Spacebar sticking; under warranty until 2027-08.', state: 'in_progress', priority: 'P2', assignee: 'u_carol', requester: 'u_dave', createdAt: '2026-05-19T14:00:00Z', updatedAt: '2026-05-21T09:30:00Z', comments: [{ author: 'u_carol', at: '2026-05-20T10:00:00Z', body: 'Ordered replacement; ETA Wed.' }] },
	{ id: 'LIN-102', project: 'SECURITY', title: 'Staging DB access request — migration project', description: 'Requester needs RW access to staging.users + staging.orders for the 0042 migration. Expected duration: 5 days.', state: 'todo', priority: 'P2', assignee: null, requester: 'u_alice', createdAt: '2026-05-22T11:15:00Z', updatedAt: '2026-05-22T11:15:00Z', comments: [] },
	{ id: 'LIN-103', project: 'INFRA', title: 'Pager fires every 2h — Redis memory pressure', description: 'Cache eviction is hitting 80% in the EU region.', state: 'in_progress', priority: 'P1', assignee: 'u_alice', requester: 'u_alice', createdAt: '2026-05-23T22:00:00Z', updatedAt: '2026-05-24T07:00:00Z', comments: [{ author: 'u_alice', at: '2026-05-23T22:30:00Z', body: "Started investigation; suspect a cache key spike from yesterday's deploy." }] },
];

const store = new MockStore<LinearIssue>(SEED);

function nextId(): string {
	const nums = store.list().filter((i) => i.id.startsWith('LIN-')).map((i) => parseInt(i.id.slice(4), 10)).filter((n) => !isNaN(n));
	const next = (nums.length === 0 ? 100 : Math.max(...nums)) + 1;
	return `LIN-${next}`;
}

const createSchema = z.object({
	project: z.string().min(1),
	title: z.string().min(1),
	description: z.string().min(1),
	priority: z.enum(['P0', 'P1', 'P2', 'P3', 'P4']),
	requester: z.string().min(1),
	assignee: z.string().optional(),
});
export const createIssue = createTool({
	description: 'File a new Linear ticket. REQUIRED args: `project` (e.g. "IT", "SECURITY", "INFRA"), `title`, `description`, `priority` (one of P0/P1/P2/P3/P4), `requester` (user id). Optional `assignee`. Returns the created issue with its assigned id.',
	inputSchema: createSchema,
	async execute(args) {
		const id = nextId();
		const now = new Date().toISOString();
		const issue: LinearIssue = {
			id,
			project: args.project,
			title: args.title,
			description: args.description,
			state: 'todo',
			priority: args.priority,
			assignee: args.assignee ?? null,
			requester: args.requester,
			createdAt: now,
			updatedAt: now,
			comments: [],
		};
		// MockStore lacks insert; use update with full record
		(store as any).map.set(id, issue);
		return issue;
	},
});

const listSchema = z.object({
	project: z.string().optional(),
	state: z.enum(['todo', 'in_progress', 'in_review', 'done', 'canceled']).optional(),
	assignee: z.string().optional(),
	requester: z.string().optional(),
	limit: z.number().int().positive().optional(),
});
export const listIssues = createTool({
	description: 'List Linear issues. All filters optional: `project`, `state`, `assignee`, `requester`, `limit` (default 20).',
	inputSchema: listSchema,
	async execute({ project, state, assignee, requester, limit }) {
		const hits = store.list().filter((i) =>
			(!project || i.project === project) &&
			(!state || i.state === state) &&
			(!assignee || i.assignee === assignee) &&
			(!requester || i.requester === requester),
		);
		return { count: hits.length, issues: hits.slice(0, limit ?? 20) };
	},
});

const getSchema = z.object({ id: z.string().min(1) });
export const getIssue = createTool({
	description: 'Fetch a Linear issue by id. REQUIRED arg: `id` (e.g. "LIN-102").',
	inputSchema: getSchema,
	async execute({ id }) {
		const i = store.get(id);
		return i ?? { error: 'issue-not-found', id };
	},
});

const commentSchema = z.object({ id: z.string().min(1), author: z.string().min(1), body: z.string().min(1) });
export const addComment = createTool({
	description: 'Add a comment to an existing Linear issue. ALL THREE args REQUIRED: `id` (issue id), `author` (user id), `body`. Bumps updatedAt.',
	inputSchema: commentSchema,
	async execute({ id, author, body }) {
		const issue = store.get(id);
		if (!issue) return { error: 'unknown_issue', id };
		const now = new Date().toISOString();
		const comments = [...issue.comments, { author, at: now, body }];
		return store.update(id, { comments, updatedAt: now });
	},
});

const stateSchema = z.object({ id: z.string().min(1), state: z.enum(['todo', 'in_progress', 'in_review', 'done', 'canceled']) });
export const updateState = createTool({
	description: 'Move a Linear issue to a new state. BOTH args REQUIRED: `id`, `state`.',
	inputSchema: stateSchema,
	async execute({ id, state }) {
		const issue = store.get(id);
		if (!issue) return { error: 'unknown_issue', id };
		return store.update(id, { state, updatedAt: new Date().toISOString() });
	},
});

export const linearTools = { createIssue, listIssues, getIssue, addComment, updateState };
