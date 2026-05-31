/**
 * Notion-shaped documentation mock.
 */
import { z } from 'zod';
import { createTool } from '@kuralle-agents/core';
import { MockStore } from './store.js';

export interface NotionPage {
	id: string;
	title: string;
	tags: string[];
	lastEdited: string;
	body: string;
}

const SEED: NotionPage[] = [
	{
		id: 'page_staging_access',
		title: 'Staging database access policy',
		tags: ['security', 'data', 'access'],
		lastEdited: '2026-04-12T15:30:00Z',
		body: "Requesting staging DB access\n\nWho approves: the requester's manager + a data-platform on-call.\n\nProcess:\n1. File a Linear ticket in the SECURITY project with the migration scope, expected duration, and a one-line justification.\n2. Tag the data-platform on-call from the #data-oncall rotation.\n3. Access expires automatically after 7 days unless extended.\n\nWhat counts as 'migration scope': read/write tables, expected row counts, whether you'll be running DDL.\n\nRejection criteria: PII tables (require legal sign-off), payments tables (require finance sign-off).",
	},
	{
		id: 'page_oncall_rotation',
		title: 'On-call rotation',
		tags: ['oncall', 'people', 'runbook'],
		lastEdited: '2026-05-19T08:00:00Z',
		body: 'Weekly rotation. Current week: u_alice (eng-platform). Backup: u_bob.\n\nHandoff: Mondays 09:00. The outgoing on-call writes a one-paragraph handoff in the rotation Linear ticket.\n\nPager: Linear ticket priority P1 → page; P2 → Slack DM; P3 → ticket only.\n\nSLAs: P1 ack < 15min, P2 ack < 1h, P3 ack < 4h business hours.',
	},
	{
		id: 'page_password_reset',
		title: 'Self-service password reset (Okta)',
		tags: ['it', 'okta', 'self-service'],
		lastEdited: '2026-03-01T12:00:00Z',
		body: "Acme uses Okta for SSO. To reset your password yourself:\n1. Go to acme.okta.example/reset\n2. Enter your email; click 'Send recovery link'\n3. Click the link in the email (valid 15 min)\n4. Set a new password (12+ chars, must contain digit + symbol)\n\nIf you don't get the email within 5 min, check spam, then file a Linear ticket in the IT project.",
	},
	{
		id: 'page_vpn_setup',
		title: 'VPN setup — Tailscale',
		tags: ['it', 'network', 'self-service'],
		lastEdited: '2026-02-10T16:00:00Z',
		body: "Acme uses Tailscale for VPN. Install at tailscale.com/download. Auth via your Okta email. You'll automatically be in the 'acme' tailnet.\n\nFor staging access, you also need the 'staging-vpn' group (request via the staging-access flow).",
	},
	{
		id: 'page_software_request',
		title: 'Requesting new software',
		tags: ['it', 'purchasing', 'policy'],
		lastEdited: '2026-04-30T10:15:00Z',
		body: 'Approved tools (no ticket needed): Slack, Linear, Notion, GitHub, VS Code, JetBrains IDEs, Figma, Zoom.\n\nFor anything else: file a Linear ticket in the IT project. Include: name, vendor, monthly cost, business justification, and whether it processes customer data (if yes, security review required first).\n\nSecurity-reviewed list lives in a separate page; ask IT for the latest.',
	},
];

const store = new MockStore<NotionPage>(SEED);

const searchSchema = z.object({
	query: z.string().min(1, 'query is required'),
	limit: z.number().int().positive().optional(),
});
export const searchPages = createTool({
	description: 'Search Notion docs by query string (case-insensitive substring over title/tags/body). REQUIRED arg: `query`. Optional `limit` (default 5). Returns id + title + tags + 200-char body preview per hit.',
	inputSchema: searchSchema,
	async execute({ query, limit }) {
		const q = query.trim().toLowerCase();
		if (!q) return { error: 'query-missing' };
		const matches = store.list().filter(
			(p) => p.title.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q)) || p.body.toLowerCase().includes(q),
		);
		return {
			count: matches.length,
			pages: matches.slice(0, limit ?? 5).map((p) => ({
				id: p.id,
				title: p.title,
				tags: p.tags,
				preview: p.body.slice(0, 200) + (p.body.length > 200 ? '…' : ''),
			})),
		};
	},
});

const idSchema = z.object({ id: z.string().min(1) });
export const getPage = createTool({
	description: 'Fetch the full body of a Notion page by id (e.g. "page_staging_access"). REQUIRED arg: `id`.',
	inputSchema: idSchema,
	async execute({ id }) {
		const p = store.get(id);
		return p ?? { error: 'page-not-found', id };
	},
});

const tagSchema = z.object({ tag: z.string().min(1) });
export const listByTag = createTool({
	description: 'List every Notion page carrying a tag. REQUIRED arg: `tag` (e.g. "runbook", "security"). Returns id + title + lastEdited per match.',
	inputSchema: tagSchema,
	async execute({ tag }) {
		return store.list().filter((p) => p.tags.includes(tag)).map((p) => ({ id: p.id, title: p.title, lastEdited: p.lastEdited }));
	},
});

export const notionTools = { searchPages, getPage, listByTag };
