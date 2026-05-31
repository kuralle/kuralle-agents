import { defineAgent, type AgentConfig } from '@kuralle-agents/core';
import type { LanguageModel } from 'ai';
import {
	notionService as notion,
	linearService as linear,
	calendarService as cal,
	emailService as email,
} from '@kuralle-templates/_shared-mock-services';
import { commitmentsTools } from './commitments.js';
import { wireTools } from '@kuralle-templates/_shared-mock-services/runtime/v2Tools';

export function buildAgents(model: LanguageModel): AgentConfig[] {
	const allOrgTools = wireTools({
		...notion.notionTools,
		...linear.linearTools,
		...cal.calendarTools,
		...email.emailTools,
	});

	const commsTools = wireTools({
		draftReply: email.draftReply,
		getMessage: email.getMessage,
		getPage: notion.getPage,
		searchPages: notion.searchPages,
	});

	const commitmentTools = wireTools(commitmentsTools);

	const general = defineAgent({
		id: 'general',
		name: 'General CoS Assistant',
		model,
		instructions: `Chief-of-staff direct-lookup assistant. Calendar, email, ticket fetches. Brief replies. Cite sources.`,
		tools: allOrgTools.tools,
		effectTools: allOrgTools.effectTools,
		knowledge: {},
	});

	const commsDrafter = defineAgent({
		id: 'comms-drafter',
		name: 'Comms Drafter',
		model,
		instructions: `Draft strategic communications for ONE leader. Read communication-norms first.
NEVER autonomously send. Sign-off: —C`,
		tools: commsTools.tools,
		effectTools: commsTools.effectTools,
		knowledge: {},
	});

	const execBrieferTools = wireTools({
		...notion.notionTools,
		...linear.linearTools,
		...cal.calendarTools,
		...email.emailTools,
		...commitmentsTools,
	});

	const execBriefer = defineAgent({
		id: 'exec-briefer',
		name: 'Exec Briefer',
		model,
		instructions: `Produce pre-meeting briefs with Context, Recent activity, Open from prior, Recommended ask sections.`,
		tools: execBrieferTools.tools,
		effectTools: execBrieferTools.effectTools,
		knowledge: {},
	});

	const commitmentTracker = defineAgent({
		id: 'commitment-tracker',
		name: 'Commitment Tracker',
		model,
		instructions: `Track what the leader promised. Use listCommitments, logCommitment, updateCommitmentStatus.`,
		tools: commitmentTools.tools,
		effectTools: commitmentTools.effectTools,
		knowledge: {},
	});

	const coordinator = defineAgent({
		id: 'coordinator',
		name: 'Chief of Staff',
		model,
		instructions: `Route the leader's request to the right specialist. NEVER send autonomously to board or customers.`,
		routes: [
			{ agent: 'comms-drafter', when: 'Draft strategic communications — board updates, all-hands, customer emails.' },
			{ agent: 'exec-briefer', when: 'Pre-meeting briefs before a 1:1 or review.' },
			{ agent: 'commitment-tracker', when: 'Promises made, overdue commitments, log or mark done.' },
			{ agent: 'general', when: 'Direct lookups — calendar, OKR status, specific ticket.' },
		],
		routing: { default: 'general', mode: 'structured' },
		agents: [general, commsDrafter, execBriefer, commitmentTracker],
		memory: { preload: { enabled: true }, ingest: { enabled: true } },
	});

	return [coordinator, general, commsDrafter, execBriefer, commitmentTracker];
}
