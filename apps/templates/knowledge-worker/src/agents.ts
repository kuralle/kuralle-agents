import { defineAgent, BuiltinPersonas, composePersonaPrompt, type AgentConfig } from '@kuralle-agents/core';
import type { LanguageModel } from 'ai';
import {
	notionService as notion,
	linearService as linear,
	calendarService as cal,
	emailService as email,
} from '@kuralle-templates/_shared-mock-services';
import { wireTools } from '@kuralle-templates/_shared-mock-services/runtime/v2Tools';

export function buildAgents(model: LanguageModel): AgentConfig[] {
	const allTools = wireTools({
		...notion.notionTools,
		...linear.linearTools,
		...cal.calendarTools,
		...email.emailTools,
	});

	const drafterTools = wireTools({
		draftReply: email.draftReply,
		getMessage: email.getMessage,
		createIssue: linear.createIssue,
	});

	const summarizerTools = wireTools({
		getMessage: email.getMessage,
		getPage: notion.getPage,
		getIssue: linear.getIssue,
		getEvent: cal.getEvent,
	});

	const general = defineAgent({
		id: 'general',
		name: 'General Assistant',
		model,
		instructions: `${composePersonaPrompt(BuiltinPersonas.brief)}

Personal assistant. Direct lookups only — calendar, email, ticket fetches.`,
		tools: allTools.tools,
		effectTools: allTools.effectTools,
		knowledge: {},
		memory: { preload: { enabled: true }, ingest: { enabled: true } },
	});

	const researcher = defineAgent({
		id: 'researcher',
		name: 'Researcher',
		model,
		instructions: `${composePersonaPrompt(BuiltinPersonas.brief)}

Research specialist. Plan tools, synthesize TL;DR + bullets, cite LIN-NNN and page titles.`,
		tools: allTools.tools,
		effectTools: allTools.effectTools,
		knowledge: {},
	});

	const drafter = defineAgent({
		id: 'drafter',
		name: 'Drafter',
		model,
		instructions: `${composePersonaPrompt(BuiltinPersonas.brief)}

Compose emails and tickets. ALWAYS use draftReply. NEVER send autonomously.`,
		tools: drafterTools.tools,
		effectTools: drafterTools.effectTools,
		knowledge: {},
	});

	const summarizer = defineAgent({
		id: 'summarizer',
		name: 'Summarizer',
		model,
		instructions: `${composePersonaPrompt(BuiltinPersonas.brief)}

TL;DR + 3-5 bullets + open questions only when needed.`,
		tools: summarizerTools.tools,
		effectTools: summarizerTools.effectTools,
		knowledge: {},
	});

	const coordinator = defineAgent({
		id: 'coordinator',
		name: 'Personal Coordinator',
		model,
		instructions: `${composePersonaPrompt(BuiltinPersonas.brief)}

Personal AI coordinator. Route requests. You DRAFT, you don't SEND.`,
		routes: [
			{ agent: 'researcher', when: 'Multi-step research spanning 2+ tools.' },
			{ agent: 'drafter', when: 'Compose email, doc paragraph, or ticket description.' },
			{ agent: 'summarizer', when: 'Summarize long content into TL;DR + bullets.' },
			{ agent: 'general', when: 'Direct lookups: calendar, email, ticket, simple Q&A.' },
		],
		routing: { default: 'general', mode: 'structured' },
		agents: [general, researcher, drafter, summarizer],
		memory: { preload: { enabled: true }, ingest: { enabled: true } },
	});

	return [coordinator, general, researcher, drafter, summarizer];
}
