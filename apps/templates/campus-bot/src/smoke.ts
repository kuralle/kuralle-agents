import { InMemoryMemoryService } from '@kuralle-agents/core';
import { buildAgents } from './agents.js';
import { knowledgeConfig } from './knowledge.js';
import { loadTemplateEnv, resolveTemplateModel } from '@kuralle-templates/_shared-mock-services/runtime/model';
import { runTemplateConversation } from '@kuralle-templates/_shared-mock-services/runtime/smokeRunner';

loadTemplateEnv(import.meta.url);
const { model, label } = resolveTemplateModel();

runTemplateConversation({
	title: `campus-bot live smoke (${label})`,
	agents: buildAgents(model),
	defaultAgentId: 'coordinator',
	model,
	knowledge: knowledgeConfig,
	memoryService: new InMemoryMemoryService(),
	prompts: [
		'Hi, I am student s_001. What is my GPA?',
		'Can you check my financial aid package?',
		'I want to drop CS 351 from my schedule.',
		'Thanks, that helps!',
	],
}).catch((err) => {
	console.error(err);
	process.exit(1);
});
