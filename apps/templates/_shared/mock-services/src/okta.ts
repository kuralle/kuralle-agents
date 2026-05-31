/**
 * Okta-shaped directory mock. Ported from @floe/mock-services/okta.
 */
import { z } from 'zod';
import { createTool } from '@kuralle-agents/core';
import { MockStore } from './store.js';

export interface OktaUser {
	id: string;
	email: string;
	displayName: string;
	department: string;
	title: string;
	manager: string | null;
	groups: string[];
	status: 'active' | 'suspended' | 'deactivated';
}

const SEED: OktaUser[] = [
	{ id: 'u_alice', email: 'alice@acme.example', displayName: 'Alice Chen', department: 'Engineering', title: 'Staff Engineer', manager: 'u_bob', groups: ['g_eng', 'g_oncall', 'g_staging-readwrite'], status: 'active' },
	{ id: 'u_bob', email: 'bob@acme.example', displayName: 'Bob Sutton', department: 'Engineering', title: 'Engineering Manager', manager: 'u_carol', groups: ['g_eng', 'g_managers'], status: 'active' },
	{ id: 'u_carol', email: 'carol@acme.example', displayName: 'Carol Marsh', department: 'Engineering', title: 'Director of Engineering', manager: null, groups: ['g_eng', 'g_managers', 'g_directors'], status: 'active' },
	{ id: 'u_dave', email: 'dave@acme.example', displayName: 'Dave Liu', department: 'Sales', title: 'Account Executive', manager: 'u_eve', groups: ['g_sales'], status: 'active' },
	{ id: 'u_eve', email: 'eve@acme.example', displayName: 'Eve Patel', department: 'Sales', title: 'Sales Director', manager: null, groups: ['g_sales', 'g_managers', 'g_directors'], status: 'active' },
];

const store = new MockStore<OktaUser>(SEED);

const emailSchema = z.object({ email: z.string().min(1, 'email is required') });
export const lookupUserByEmail = createTool({
	description: 'Look up an Okta user by email. REQUIRED arg: `email`. Returns id, displayName, department, title, manager, groups, status. Null if not found.',
	inputSchema: emailSchema,
	async execute({ email }) {
		const e = email.trim().toLowerCase();
		if (!e) return { error: 'email-missing' };
		const u = store.find((x) => x.email.toLowerCase() === e);
		return u ?? { error: 'user-not-found', email };
	},
});

const idSchema = z.object({ id: z.string().min(1) });
export const lookupUserById = createTool({
	description: 'Look up an Okta user by id (e.g. "u_alice"). REQUIRED arg: `id`.',
	inputSchema: idSchema,
	async execute({ id }) {
		const u = store.get(id);
		return u ?? { error: 'user-not-found', id };
	},
});

const membershipSchema = z.object({ userId: z.string().min(1), group: z.string().min(1) });
export const checkGroupMembership = createTool({
	description: 'Return whether a user is in a group. BOTH args REQUIRED: `userId`, `group`. Returns {member: bool, groups: string[]}.',
	inputSchema: membershipSchema,
	async execute({ userId, group }) {
		const u = store.get(userId);
		if (!u) return { member: false, groups: [], error: 'unknown_user' };
		return { member: u.groups.includes(group), groups: u.groups };
	},
});

const userIdOnlySchema = z.object({ userId: z.string().min(1) });
export const findManager = createTool({
	description: 'Resolve the manager (one level up) for a user. REQUIRED arg: `userId`. Returns the manager user object or null at the top of the chain.',
	inputSchema: userIdOnlySchema,
	async execute({ userId }) {
		const u = store.get(userId);
		if (!u) return { error: 'unknown_user', userId };
		if (!u.manager) return null;
		return store.get(u.manager);
	},
});

const groupSchema = z.object({ group: z.string().min(1) });
export const listGroupMembers = createTool({
	description: 'List every user in a given group. REQUIRED arg: `group`. Returns an array of users.',
	inputSchema: groupSchema,
	async execute({ group }) {
		return store.list().filter((u) => u.groups.includes(group));
	},
});

export const oktaTools = { lookupUserByEmail, lookupUserById, checkGroupMembership, findManager, listGroupMembers };
