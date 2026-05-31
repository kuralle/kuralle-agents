import { InMemoryMemoryService } from '@kuralle-agents/core';
import { buildAgents } from './agents.js';
import { knowledgeConfig } from './knowledge.js';
import { loadTemplateEnv, resolveTemplateModel } from '@kuralle-templates/_shared-mock-services/runtime/model';
import { runTemplateConversation } from '@kuralle-templates/_shared-mock-services/runtime/smokeRunner';

loadTemplateEnv(import.meta.url);
const { model, label } = resolveTemplateModel();

runTemplateConversation({
	title: `knowledge-worker live smoke (${label})`,
	agents: buildAgents(model),
	defaultAgentId: 'coordinator',
	model,
	knowledge: knowledgeConfig,
	memoryService: new InMemoryMemoryService(),
	prompts: [
		'What is on my calendar tomorrow?',
		'Catch me up on the Redis memory pressure ticket from this week.',
		'Draft a reply to the latest email from bob@acme.example about the retention plan.',
	],
}).catch((err) => {
	console.error(err);
	process.exit(1);
});
