/**
 * Calendar (Google / M365 -shaped) mock.
 */
import { z } from 'zod';
import { createTool } from '@kuralle-agents/core';
import { MockStore } from './store.js';

export interface CalendarEvent {
	id: string;
	title: string;
	start: string;
	end: string;
	attendees: string[];
	location: string;
	description: string;
	status: 'confirmed' | 'tentative' | 'cancelled';
}

const SEED: CalendarEvent[] = [
	{ id: 'evt_standup_w22', title: 'Eng standup', start: '2026-05-25T16:00:00Z', end: '2026-05-25T16:15:00Z', attendees: ['me@acme.example', 'alice@acme.example', 'bob@acme.example'], location: 'Zoom — standing link', description: 'Daily 9a PT.', status: 'confirmed' },
	{ id: 'evt_q3_planning', title: 'Q3 planning kickoff', start: '2026-05-26T18:00:00Z', end: '2026-05-26T19:30:00Z', attendees: ['me@acme.example', 'carol@acme.example', 'dave@acme.example', 'eve@acme.example'], location: 'Room: Mariner (HQ-2)', description: 'Initial scoping for the Q3 roadmap. Bring last-quarter postmortems + the top-5 user-research themes.', status: 'confirmed' },
	{ id: 'evt_1on1_carol', title: '1:1 with Carol', start: '2026-05-27T20:00:00Z', end: '2026-05-27T20:30:00Z', attendees: ['me@acme.example', 'carol@acme.example'], location: 'Zoom', description: 'Weekly. Agenda: shipping milestones, blockers, career arc.', status: 'confirmed' },
	{ id: 'evt_design_review', title: 'Design review — pricing-page redesign', start: '2026-05-28T17:00:00Z', end: '2026-05-28T18:00:00Z', attendees: ['me@acme.example', 'dave@acme.example', 'alice@acme.example'], location: 'Figma + Zoom', description: 'Walk-through of the v3 pricing-page mocks. Decide on the comparison table format.', status: 'confirmed' },
	{ id: 'evt_focus_block', title: 'Focus block — Q3 doc draft', start: '2026-05-29T15:00:00Z', end: '2026-05-29T18:00:00Z', attendees: ['me@acme.example'], location: '(none)', description: 'No meetings. Heads-down on the Q3 strategy doc.', status: 'confirmed' },
];

const store = new MockStore<CalendarEvent>(SEED);

const listSchema = z.object({ start: z.string().min(1), end: z.string().min(1), limit: z.number().int().positive().optional() });
export const listEvents = createTool({
	description: 'List events between two ISO-8601 timestamps. REQUIRED args: `start`, `end` (both ISO-8601 UTC). Optional `limit` (default 50). Sorted by start ASC.',
	inputSchema: listSchema,
	async execute({ start, end, limit }) {
		const hits = store.list().filter((e) => e.start >= start && e.start <= end).sort((a, b) => a.start.localeCompare(b.start)).slice(0, limit ?? 50);
		return { count: hits.length, events: hits };
	},
});

const findSchema = z.object({ titleFragment: z.string().min(1) });
export const findEvent = createTool({
	description: 'Find the next-upcoming event by case-insensitive title substring. REQUIRED arg: `titleFragment`. Returns the event or null.',
	inputSchema: findSchema,
	async execute({ titleFragment }) {
		const n = titleFragment.trim().toLowerCase();
		if (!n) return { error: 'titleFragment-missing' };
		const matches = store.list().filter((e) => e.title.toLowerCase().includes(n)).sort((a, b) => a.start.localeCompare(b.start));
		return matches[0] ?? { error: 'no-match', titleFragment };
	},
});

const idSchema = z.object({ id: z.string().min(1) });
export const getEvent = createTool({
	description: 'Fetch a calendar event by id. REQUIRED arg: `id`.',
	inputSchema: idSchema,
	async execute({ id }) {
		const e = store.get(id);
		return e ?? { error: 'event-not-found', id };
	},
});

const createSchema = z.object({
	title: z.string().min(1),
	start: z.string().min(1),
	end: z.string().min(1),
	attendees: z.array(z.string()).min(1),
	location: z.string().optional(),
	description: z.string().optional(),
});
export const createEvent = createTool({
	description: 'Book a new calendar event. REQUIRED args: `title`, `start` (ISO-8601), `end` (ISO-8601), `attendees` (array of emails, non-empty). Optional `location`, `description`. Returns the event with its assigned id.',
	inputSchema: createSchema,
	async execute(args) {
		const id = `evt_${Math.random().toString(36).slice(2, 10)}`;
		const evt: CalendarEvent = { id, title: args.title, start: args.start, end: args.end, attendees: args.attendees, location: args.location ?? '', description: args.description ?? '', status: 'confirmed' };
		(store as any).map.set(id, evt);
		return evt;
	},
});

export const cancelEvent = createTool({
	description: 'Cancel a calendar event (sets status=cancelled). REQUIRED arg: `id`.',
	inputSchema: idSchema,
	async execute({ id }) {
		const e = store.get(id);
		if (!e) return { error: 'event-not-found', id };
		return store.update(id, { status: 'cancelled' });
	},
});

export const calendarTools = { listEvents, findEvent, getEvent, createEvent, cancelEvent };
