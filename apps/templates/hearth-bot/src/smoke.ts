import { InMemoryMemoryService } from '@kuralle-agents/core';
import { buildAgents } from './agents.js';
import { knowledgeConfig } from './knowledge.js';
import { loadTemplateEnv, resolveTemplateModel } from '@kuralle-templates/_shared-mock-services/runtime/model';
import { runTemplateConversation } from '@kuralle-templates/_shared-mock-services/runtime/smokeRunner';

loadTemplateEnv(import.meta.url);
const { model, label } = resolveTemplateModel();

runTemplateConversation({
	title: `hearth-bot live smoke (${label})`,
	agents: buildAgents(model),
	defaultAgentId: 'coordinator',
	model,
	knowledge: knowledgeConfig,
	memoryService: new InMemoryMemoryService(),
	prompts: [
		'Hi, my email is alice@example.com — can I skip next week?',
		'Actually I want to cancel my subscription.',
		'No thanks, just cancel it please.',
	],
}).catch((err) => {
	console.error(err);
	process.exit(1);
});
