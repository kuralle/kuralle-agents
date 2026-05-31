import { InMemoryMemoryService } from '@kuralle-agents/core';
import { buildAgents } from './agents.js';
import { knowledgeConfig } from './knowledge.js';
import { loadTemplateEnv, resolveTemplateModel } from '@kuralle-templates/_shared-mock-services/runtime/model';
import { runTemplateConversation } from '@kuralle-templates/_shared-mock-services/runtime/smokeRunner';

loadTemplateEnv(import.meta.url);
const { model, label } = resolveTemplateModel();

runTemplateConversation({
	title: `ops-bot live smoke (${label})`,
	agents: buildAgents(model),
	defaultAgentId: 'ops',
	model,
	knowledge: knowledgeConfig,
	memoryService: new InMemoryMemoryService(),
	prompts: [
		'Hi, I forgot my password and cannot log into Okta.',
		'I need staging database access for the migration project — my manager already approved.',
		'Can I get Figma installed? It is not on the approved list.',
	],
}).catch((err) => {
	console.error(err);
	process.exit(1);
});
