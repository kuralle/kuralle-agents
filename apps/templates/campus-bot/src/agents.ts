import { z } from 'zod';
import {
	action,
	collect,
	defineAgent,
	defineFlow,
	reply,
	type AgentConfig,
} from '@kuralle-agents/core';
import type { LanguageModel } from 'ai';
import {
	bookAdvisorMeeting,
	checkFinancialAid,
	getEnrollment,
	listUpcomingDeadlines,
	lookupStudent,
	searchCourses,
} from './tools.js';
import { wireTools } from '@kuralle-templates/_shared-mock-services/runtime/v2Tools';

function currentWeek(): number {
	return Number(process.env.CAMPUS_MOCK_TERM_WEEK ?? 3);
}

const campusToolDefs = {
	lookupStudent,
	getEnrollment,
	listUpcomingDeadlines,
	searchCourses,
	bookAdvisorMeeting,
	checkFinancialAid,
};

const advisorTools = wireTools({
	lookupStudent,
	getEnrollment,
	listUpcomingDeadlines,
	searchCourses,
	bookAdvisorMeeting,
});

const financialAidTools = wireTools({
	lookupStudent,
	checkFinancialAid,
	listUpcomingDeadlines,
});

function buildAddDropFlow(model: LanguageModel) {
	const explainAddAllowed = reply({
		id: 'explain-add-allowed',
		instructions: ({ state }) =>
			`Confirm in ONE short sentence that the student can still add ${state.courseCode ?? 'the course'} ` +
			`(currently week ${currentWeek()}; add deadline is end of week 2). Direct them to the registrar portal.`,
		model,
		next: () => ({ end: 'completed' }),
	});

	const explainAddClosed = reply({
		id: 'explain-add-closed',
		instructions: ({ state }) =>
			`In ONE short sentence, tell the student the add window closed at end of week 2 (today is week ${currentWeek()}) ` +
			`for ${state.courseCode ?? 'the course'}. Late add requires instructor signature.`,
		model,
		next: () => ({ end: 'completed' }),
	});

	const explainDropNoW = reply({
		id: 'explain-drop-no-w',
		instructions: ({ state }) =>
			`In ONE short sentence, confirm the student can drop ${state.courseCode ?? 'the course'} cleanly (week ${currentWeek()}, before no-W deadline). ` +
			'Mention refund schedule and Student Accounts.',
		model,
		next: () => ({ end: 'completed' }),
	});

	const explainDropWithW = reply({
		id: 'explain-drop-with-w',
		instructions: ({ state }) =>
			`In ONE short sentence, dropping ${state.courseCode ?? 'the course'} now (week ${currentWeek()}) posts a W with no refund. Ask if they still want to proceed.`,
		model,
		next: () => ({ end: 'completed' }),
	});

	const windowClosed = reply({
		id: 'window-closed',
		instructions: ({ state }) =>
			`In ONE short sentence, the drop window closed for ${state.courseCode ?? 'the course'} (week ${currentWeek()}). ` +
			"Withdrawal now needs Dean's approval.",
		model,
		next: () => ({ end: 'completed' }),
	});

	const routeAction = action({
		id: 'route',
		run: (state) => {
			const act = String(state.action ?? '').toLowerCase();
			const week = currentWeek();
			if (act === 'add' && week <= 2) return explainAddAllowed;
			if (act === 'add') return explainAddClosed;
			if (act === 'drop' && week <= 4) return explainDropNoW;
			if (act === 'drop' && week <= 10) return explainDropWithW;
			if (act === 'drop') return windowClosed;
			return explainAddClosed;
		},
	});

	const collectRequest = collect({
		id: 'collect-request',
		schema: z.object({
			courseCode: z.string().describe('Department code + number, e.g. CS 101'),
			action: z.enum(['add', 'drop']).describe('Either add or drop'),
		}),
		required: ['courseCode', 'action'],
		maxTurns: 4,
		instructions: (missing) =>
			`Collect courseCode and action (add/drop). Missing: ${missing.join(', ') || 'none'}. One short question at a time.`,
		onComplete: () => routeAction,
	});

	return defineFlow({
		name: 'add-drop',
		description: 'Add or drop a specific course',
		start: collectRequest,
		nodes: [
			collectRequest,
			routeAction,
			explainAddAllowed,
			explainAddClosed,
			explainDropNoW,
			explainDropWithW,
			windowClosed,
		],
		instructions: 'Guide the student through a course add or drop.',
	});
}

export function buildAgents(model: LanguageModel): AgentConfig[] {
	const addDropFlow = buildAddDropFlow(model);

	const academicAdvisor = defineAgent({
		id: 'academic-advisor',
		name: 'Academic Advisor',
		model,
		instructions: `You are the student's academic advisor.

OPERATING RULES:
- If the student gives an email or student id, call lookupStudent first.
- For enrollment questions, call getEnrollment after lookupStudent.
- For probation (GPA < 2.0), surface gently and offer bookAdvisorMeeting.
- Reference help-center knowledge in your system prompt. Do not invent policies.
- Be warm, brief, direct. 2-4 sentences for chat.`,
		tools: advisorTools.tools,
		effectTools: advisorTools.effectTools,
		knowledge: {},
	});

	const financialAid = defineAgent({
		id: 'financial-aid',
		name: 'Financial Aid',
		model,
		instructions: `You are the financial aid specialist.

OPERATING RULES:
- Always call lookupStudent + checkFinancialAid before quoting amounts.
- Reference help-center knowledge. Do not invent policies.
- If SAP is warning or suspended, explain appeal process gently.
- Be warm, brief, direct.`,
		tools: financialAidTools.tools,
		effectTools: financialAidTools.effectTools,
		knowledge: {},
	});

	const wellbeing = defineAgent({
		id: 'wellbeing',
		name: 'Wellbeing',
		model,
		instructions: `You are the wellbeing specialist.

OPERATING RULES:
- For crisis, distress, self-harm, or feeling unsafe — surface Campus Care Line 1-800-555-CARE in your FIRST sentence.
- For imminent emergency → 911 or campus safety 1-800-555-SAFE.
- Never minimize. Point to offices from wellbeing knowledge.`,
		knowledge: {},
	});

	const addDropAgent = defineAgent({
		id: 'add-drop-flow',
		name: 'Add/Drop',
		model,
		instructions: 'Guide the student through adding or dropping a course.',
		flows: [addDropFlow],
	});

	const coordinator = defineAgent({
		id: 'coordinator',
		name: 'Campus Coordinator',
		model,
		instructions: `You are the campus student-relationship coordinator. Route the
student to the right specialist. Do not answer substantive academic, financial,
wellbeing, or add/drop questions yourself — route them.

For greetings or thanks, you may answer briefly without routing.`,
		routes: [
			{
				agent: 'academic-advisor',
				when:
					'Degree planning, course selection, prerequisites, GPA, academic standing, enrollment, schedule advice.',
			},
			{
				agent: 'financial-aid',
				when: 'Aid packages, scholarships, payment plans, work-study, SAP, balance due, FAFSA.',
			},
			{
				agent: 'wellbeing',
				when: 'Counseling, mental health, accessibility, food insecurity, Title IX, crisis or distress.',
			},
			{
				agent: 'add-drop-flow',
				when: 'Add or drop a specific course (course code like CS 101 with add/drop intent).',
			},
		],
		routing: { default: 'academic-advisor', mode: 'structured' },
		agents: [academicAdvisor, financialAid, wellbeing, addDropAgent],
		memory: { preload: { enabled: true }, ingest: { enabled: true } },
	});

	return [coordinator, academicAdvisor, financialAid, wellbeing, addDropAgent];
}
