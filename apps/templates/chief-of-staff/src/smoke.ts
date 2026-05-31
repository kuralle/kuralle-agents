import { InMemoryMemoryService } from '@kuralle-agents/core';
import { buildAgents } from './agents.js';
import { knowledgeConfig } from './knowledge.js';
import { loadTemplateEnv, resolveTemplateModel } from '@kuralle-templates/_shared-mock-services/runtime/model';
import { runTemplateConversation } from '@kuralle-templates/_shared-mock-services/runtime/smokeRunner';

loadTemplateEnv(import.meta.url);
const { model, label } = resolveTemplateModel();

runTemplateConversation({
	title: `chief-of-staff live smoke (${label})`,
	agents: buildAgents(model),
	defaultAgentId: 'coordinator',
	model,
	knowledge: knowledgeConfig,
	memoryService: new InMemoryMemoryService(),
	prompts: [
		'What commitments are overdue this week?',
		'Brief me on my 1:1 with bob@acme.example tomorrow.',
		'Draft a short board update on Q3 priorities progress.',
	],
}).catch((err) => {
	console.error(err);
	process.exit(1);
});
