/**
 * Email (Gmail / Outlook -shaped) mock.
 */
import { z } from 'zod';
import { createTool } from '@kuralle-agents/core';
import { MockStore } from './store.js';

export interface EmailMessage {
	id: string;
	from: string;
	to: string[];
	cc: string[];
	subject: string;
	snippet: string;
	body: string;
	receivedAt: string;
	isRead: boolean;
	isStarred: boolean;
	labels: string[];
}

const SEED: EmailMessage[] = [
	{ id: 'msg_q3_kickoff', from: 'carol@acme.example', to: ['me@acme.example'], cc: ['eve@acme.example'], subject: 'Re: Q3 planning kickoff prep', snippet: "Quick ask — before Tuesday's kickoff, can you pull the top-5 user-research themes from the May synthesis doc? I want us to start from real evidence, not gut takes.", body: "Quick ask — before Tuesday's kickoff, can you pull the top-5 user-research themes from the May synthesis doc? I want us to start from real evidence, not gut takes.\n\nIf any of them are also tracked in Linear, can you link the corresponding tickets? That'll save us 30 min in the meeting.\n\nThanks!\n\nC.", receivedAt: '2026-05-23T18:30:00Z', isRead: false, isStarred: true, labels: ['work', 'q3-planning', 'needs-reply'] },
	{ id: 'msg_design_review', from: 'dave@acme.example', to: ['me@acme.example', 'alice@acme.example'], cc: [], subject: 'Pricing page v3 — design review Thursday', snippet: 'I posted the v3 mocks in Figma. Big question for the review: do we land the comparison table as a true HTML grid, or as separate cards stacked on mobile?', body: "Hey team —\n\nI posted the v3 mocks in Figma: figma.example/pricing-v3\n\nBig question for the review on Thursday: do we land the comparison table as a true HTML grid (good for SEO + a11y) or as separate cards that stack on mobile (better visual hierarchy but harder to scan side-by-side)?\n\nI'm leaning grid + a cards-only mobile breakpoint, but want to hear the eng take before we lock.\n\n— Dave", receivedAt: '2026-05-22T14:15:00Z', isRead: true, isStarred: false, labels: ['work', 'design', 'needs-reply'] },
	{ id: 'msg_security_patch', from: 'alice@acme.example', to: ['eng-team@acme.example'], cc: [], subject: 'Tailwind v4.1 patch — please upgrade by Friday', snippet: 'Heads up — Tailwind v4.1.2 fixes a class-cache invalidation bug we were seeing in CI. Please bump on your branches by EOD Friday.', body: "Heads up — Tailwind v4.1.2 fixes a class-cache invalidation bug we were seeing in CI. Please bump on your branches by EOD Friday.\n\nOne line: `npm i tailwindcss@4.1.2`\n\nRun your snapshot tests after — there's a tiny diff in how `@apply` resolves arbitrary values now. Nothing user-visible.\n\nA.", receivedAt: '2026-05-22T09:00:00Z', isRead: true, isStarred: false, labels: ['work', 'infra'] },
	{ id: 'msg_paris_dinner', from: 'jess@personal.example', to: ['me@personal.example'], cc: [], subject: 'Paris in July — pick a dinner spot?', snippet: "OK we're locked in for the 12-18. I made a shortlist of dinner spots — could you take a look this weekend and pick 2-3?", body: "OK we're locked in for the 12-18. I made a shortlist of dinner spots — could you take a look this weekend and pick 2-3? List is in the shared Notion page.\n\n💛", receivedAt: '2026-05-21T19:45:00Z', isRead: true, isStarred: true, labels: ['personal', 'travel'] },
	{ id: 'msg_recruiter', from: 'noreply@recruiter.example', to: ['me@personal.example'], cc: [], subject: 'Senior Eng role at <stealth startup>', snippet: 'Hi! Got your profile from a mutual connection. Quick chat?', body: 'Hi! Got your profile from a mutual connection. Quick chat?\n\n[unsubscribe link]', receivedAt: '2026-05-21T15:10:00Z', isRead: false, isStarred: false, labels: ['personal', 'recruiting'] },
];

const store = new MockStore<EmailMessage>(SEED);

const searchSchema = z.object({
	query: z.string().optional(),
	label: z.string().optional(),
	sender: z.string().optional(),
	unreadOnly: z.boolean().optional(),
	starredOnly: z.boolean().optional(),
	limit: z.number().int().positive().optional(),
});
export const searchMessages = createTool({
	description: 'Search the inbox. ALL args optional but at least one filter is recommended: `query` (substring over subject/body/from), `label`, `sender`, `unreadOnly`, `starredOnly`, `limit` (default 20). Returns id + from + subject + snippet + receivedAt + labels + isRead + isStarred per match, newest first.',
	inputSchema: searchSchema,
	async execute({ query, label, sender, unreadOnly, starredOnly, limit }) {
		const q = query?.trim().toLowerCase();
		const lab = label?.trim().toLowerCase();
		const snd = sender?.trim().toLowerCase();
		const hits = store.list().filter((m) => {
			if (q) {
				const hay = (m.subject + ' ' + m.body + ' ' + m.from).toLowerCase();
				if (!hay.includes(q)) return false;
			}
			if (lab && !m.labels.some((l) => l.toLowerCase() === lab)) return false;
			if (snd && !m.from.toLowerCase().includes(snd)) return false;
			if (unreadOnly && m.isRead) return false;
			if (starredOnly && !m.isStarred) return false;
			return true;
		}).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, limit ?? 20);
		return {
			count: hits.length,
			messages: hits.map((m) => ({ id: m.id, from: m.from, subject: m.subject, snippet: m.snippet, receivedAt: m.receivedAt, labels: m.labels, isRead: m.isRead, isStarred: m.isStarred })),
		};
	},
});

const idSchema = z.object({ id: z.string().min(1) });
export const getMessage = createTool({
	description: 'Fetch a single email message by id (full body). REQUIRED arg: `id`.',
	inputSchema: idSchema,
	async execute({ id }) {
		const m = store.get(id);
		return m ?? { error: 'message-not-found', id };
	},
});

const replySchema = z.object({ inReplyTo: z.string().min(1), body: z.string().min(1) });
export const draftReply = createTool({
	description: 'Create a draft reply to a message. BOTH args REQUIRED: `inReplyTo` (message id), `body`. Returns a draft id + final composed body. (Mock — production wires Gmail drafts.create.)',
	inputSchema: replySchema,
	async execute({ inReplyTo, body }) {
		const orig = store.get(inReplyTo);
		if (!orig) return { error: 'unknown_message', inReplyTo };
		return {
			ok: true,
			draftId: `dft_${Math.random().toString(36).slice(2, 10)}`,
			inReplyTo,
			to: [orig.from],
			subject: orig.subject.startsWith('Re:') ? orig.subject : `Re: ${orig.subject}`,
			body,
		};
	},
});

export const markRead = createTool({
	description: 'Mark a message as read. REQUIRED arg: `id`.',
	inputSchema: idSchema,
	async execute({ id }) {
		const m = store.get(id);
		if (!m) return { error: 'message-not-found', id };
		return store.update(id, { isRead: true });
	},
});

const starSchema = z.object({ id: z.string().min(1), starred: z.boolean() });
export const star = createTool({
	description: 'Star or unstar a message. BOTH args REQUIRED: `id`, `starred` (true to star, false to unstar).',
	inputSchema: starSchema,
	async execute({ id, starred }) {
		const m = store.get(id);
		if (!m) return { error: 'message-not-found', id };
		return store.update(id, { isStarred: starred });
	},
});

export const emailTools = { searchMessages, getMessage, draftReply, markRead, star };
