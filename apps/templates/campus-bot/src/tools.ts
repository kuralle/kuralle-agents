/**
 * Tools for campus-bot. Ported from the Floe template — same data, same
 * behavior, but using kuralle's createTool + zod.
 *
 * Production swap: replace the inline STUDENTS/ENROLLMENTS/AID_PACKAGES/
 * COURSE_CATALOG/DEADLINES mocks with real SIS / Banner / Workday reads.
 * Tool shapes stay the same — only the execute bodies change.
 */
import { createTool } from '@kuralle-agents/core';
import { z } from 'zod';

// ─── Mock data ──────────────────────────────────────────────────────

interface Student {
	studentId: string;
	email: string;
	name: string;
	year: 'freshman' | 'sophomore' | 'junior' | 'senior';
	major: string;
	gpa: number;
	standing: 'good' | 'probation' | 'dismissed';
	advisorEmail: string;
}

const STUDENTS: Record<string, Student> = {
	s_001: {
		studentId: 's_001',
		email: 'maya.tan@uni.example',
		name: 'Maya Tan',
		year: 'junior',
		major: 'Computer Science',
		gpa: 3.42,
		standing: 'good',
		advisorEmail: 'a.lee@uni.example',
	},
	s_002: {
		studentId: 's_002',
		email: 'jordan.park@uni.example',
		name: 'Jordan Park',
		year: 'sophomore',
		major: 'Undeclared',
		gpa: 1.78,
		standing: 'probation',
		advisorEmail: 'r.kim@uni.example',
	},
};

const ENROLLMENTS: Record<
	string,
	{
		term: string;
		courses: Array<{ code: string; title: string; units: number; midtermGrade?: string }>;
	}
> = {
	s_001: {
		term: 'Fall 2026',
		courses: [
			{ code: 'CS 351', title: 'Algorithms', units: 4, midtermGrade: 'B+' },
			{ code: 'CS 343', title: 'Operating Systems', units: 4, midtermGrade: 'A-' },
			{ code: 'STAT 240', title: 'Probability', units: 3, midtermGrade: 'A' },
			{ code: 'WRIT 200', title: 'Tech Writing', units: 3, midtermGrade: 'B' },
		],
	},
	s_002: {
		term: 'Fall 2026',
		courses: [
			{ code: 'BIOL 140', title: 'Intro Bio', units: 4, midtermGrade: 'C-' },
			{ code: 'CHEM 110', title: 'General Chemistry', units: 4, midtermGrade: 'D+' },
			{ code: 'ENG 101', title: 'Composition', units: 3, midtermGrade: 'C' },
		],
	},
};

const AID_PACKAGES: Record<
	string,
	{ grants: number; loans: number; workStudy: number; balanceDue: number; sapStatus: 'meeting' | 'warning' | 'suspended' }
> = {
	s_001: { grants: 8000, loans: 5500, workStudy: 3000, balanceDue: 2150, sapStatus: 'meeting' },
	s_002: { grants: 12000, loans: 5500, workStudy: 0, balanceDue: 980, sapStatus: 'warning' },
};

const COURSE_CATALOG = [
	{ code: 'CS 101', title: 'Intro to Programming', units: 4, prereqs: [] as string[] },
	{ code: 'CS 201', title: 'Data Structures', units: 4, prereqs: ['CS 101'] },
	{ code: 'CS 343', title: 'Operating Systems', units: 4, prereqs: ['CS 201'] },
	{ code: 'CS 351', title: 'Algorithms', units: 4, prereqs: ['CS 201'] },
	{ code: 'BIOL 140', title: 'Intro Bio', units: 4, prereqs: [] },
	{ code: 'BIOL 240', title: 'Cell Biology', units: 4, prereqs: ['BIOL 140'] },
	{ code: 'STAT 240', title: 'Probability', units: 3, prereqs: [] },
	{ code: 'PSYC 210', title: 'Cognitive Psych', units: 3, prereqs: [] },
];

const DEADLINES = [
	{ id: 'reg-spring', label: 'Spring registration opens', date: '2026-11-03', kind: 'registration' as const },
	{ id: 'pay-fall', label: 'Fall balance due', date: '2026-10-15', kind: 'payment' as const },
	{ id: 'fafsa', label: 'FAFSA priority deadline', date: '2026-12-01', kind: 'aid' as const },
	{ id: 'scholarship-merit', label: 'Merit scholarship renewal', date: '2027-02-15', kind: 'aid' as const },
];

// ─── Tools ──────────────────────────────────────────────────────────
// Each tool follows the defensive pattern we learned the hard way in the
// Floe session: REQUIRED in description + min(1) in schema + execute-side
// fallback. gpt-4.1-mini will call tools with {} args otherwise.

// Per-tool schema declarations — keeps the generic inference clean by
// letting us pass `z.infer<typeof schema>` to createTool's TInput.

const lookupStudentSchema = z.object({
	identifier: z.string().min(1, 'identifier is required'),
});
export const lookupStudent = createTool({
	description:
		'Look up a student. The `identifier` argument is REQUIRED and must be either the student email ' +
		'(e.g. "maya.tan@uni.example") or the student ID (e.g. "s_001"). Never call this tool without ' +
		'the identifier. Returns name, year, major, GPA, academic standing, and advisor email.',
	inputSchema: lookupStudentSchema,
	async execute({ identifier }) {
		const id = String(identifier ?? '').trim().toLowerCase();
		if (!id) return { error: 'identifier-missing', hint: 'Re-invoke with the student email or s_NNN id.' };
		for (const s of Object.values(STUDENTS)) {
			if (s.studentId.toLowerCase() === id || s.email.toLowerCase() === id) return s;
		}
		return { error: 'student-not-found', identifier };
	},
});

const studentIdOnlySchema = z.object({
	studentId: z.string().min(1, 'studentId is required'),
});

export const getEnrollment = createTool({
	description:
		'Get the current-term courses for a known student. The `studentId` argument is REQUIRED ' +
		'(e.g. "s_001"). If you only have the email, call lookupStudent first to resolve the id.',
	inputSchema: studentIdOnlySchema,
	async execute({ studentId }) {
		const id = String(studentId ?? '').trim();
		if (!id) return { error: 'studentId-missing', hint: 'Re-invoke with the s_NNN id from lookupStudent.' };
		const e = ENROLLMENTS[id];
		if (!e) return { error: 'no-enrollment-on-file', studentId: id };
		return e;
	},
});

export const checkFinancialAid = createTool({
	description:
		'Get the financial aid package summary for a student. The `studentId` argument is REQUIRED ' +
		'(e.g. "s_001"). Returns grants, loans, work-study, current balance due, and SAP status.',
	inputSchema: studentIdOnlySchema,
	async execute({ studentId }) {
		const id = String(studentId ?? '').trim();
		if (!id) return { error: 'studentId-missing', hint: 'Re-invoke with the s_NNN id from lookupStudent.' };
		const a = AID_PACKAGES[id];
		if (!a) return { error: 'no-aid-package', studentId: id };
		return a;
	},
});

const deadlinesSchema = z.object({
	kind: z.enum(['registration', 'payment', 'aid']).optional(),
});
export const listUpcomingDeadlines = createTool({
	description:
		'List upcoming campus deadlines. Optional `kind` filter — MUST be one of exactly: ' +
		'"registration", "payment", or "aid" (covers FAFSA + scholarship + aid disbursement). ' +
		'Omit `kind` to get all upcoming deadlines.',
	inputSchema: deadlinesSchema,
	async execute({ kind }) {
		const now = Date.now();
		const aliases: Record<string, 'registration' | 'payment' | 'aid'> = {
			'financial-aid': 'aid',
			'financial aid': 'aid',
			fafsa: 'aid',
			scholarship: 'aid',
			registration: 'registration',
			payment: 'payment',
			tuition: 'payment',
			aid: 'aid',
		};
		const normalized = kind ? aliases[String(kind).toLowerCase()] : undefined;
		const upcoming = DEADLINES.filter((d) => Date.parse(d.date) >= now - 86_400_000)
			.filter((d) => !normalized || d.kind === normalized)
			.sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
			.slice(0, 6);
		return { count: upcoming.length, deadlines: upcoming };
	},
});

const searchCoursesSchema = z.object({
	query: z.string().min(1, 'query is required'),
});
export const searchCourses = createTool({
	description:
		'Search the course catalog by free-text query. The `query` argument is REQUIRED — pass the ' +
		"user's search term (e.g. \"CS\" for CS courses, \"biology\" for biology, \"PSYC 210\" for " +
		'an exact code). Returns up to 8 matching courses with their prerequisites.',
	inputSchema: searchCoursesSchema,
	async execute({ query }) {
		const q = String(query ?? '').trim().toLowerCase();
		if (!q) return { error: 'query-missing', hint: "Re-invoke with the user's search term." };
		const hits = COURSE_CATALOG.filter(
			(c) => c.code.toLowerCase().includes(q) || c.title.toLowerCase().includes(q),
		).slice(0, 8);
		return { count: hits.length, courses: hits };
	},
});

const bookAdvisorMeetingSchema = z.object({
	studentId: z.string().min(1, 'studentId is required'),
	when: z.string().min(1, 'when is required'),
	topic: z.string().min(1, 'topic is required'),
});
export const bookAdvisorMeeting = createTool({
	description:
		"Schedule a 1:1 meeting with the student's advisor. ALL THREE arguments are REQUIRED: " +
		'`studentId` (e.g. "s_001"), `when` (a date/time string the human understood, e.g. ' +
		'"next Tuesday 2pm"), and `topic` (1 short phrase). Returns a confirmation id.',
	inputSchema: bookAdvisorMeetingSchema,
	async execute({ studentId, when, topic }) {
		const id = String(studentId ?? '').trim();
		const w = String(when ?? '').trim();
		const t = String(topic ?? '').trim();
		if (!id || !w || !t) {
			return {
				error: 'args-missing',
				missing: [
					...(id ? [] : ['studentId']),
					...(w ? [] : ['when']),
					...(t ? [] : ['topic']),
				],
				hint: 'Re-invoke with all three fields populated.',
			};
		}
		const s = STUDENTS[id];
		if (!s) return { error: 'student-not-found', studentId: id };
		const confirmationId = `apt_${Math.random().toString(36).slice(2, 8)}`;
		return {
			confirmationId,
			advisorEmail: s.advisorEmail,
			scheduledFor: w,
			topic: t,
			status: 'booked',
		};
	},
});

export const allTools = {
	lookupStudent,
	getEnrollment,
	checkFinancialAid,
	listUpcomingDeadlines,
	searchCourses,
	bookAdvisorMeeting,
};
