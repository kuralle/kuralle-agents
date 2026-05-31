import { InMemoryMemoryService } from '@kuralle-agents/core';
import { buildAgents } from './agents.js';
import { knowledgeConfig } from './knowledge.js';
import { loadTemplateEnv, resolveTemplateModel } from '@kuralle-templates/_shared-mock-services/runtime/model';
import { runTemplateConversation } from '@kuralle-templates/_shared-mock-services/runtime/smokeRunner';

loadTemplateEnv(import.meta.url);
const { model, label } = resolveTemplateModel();

const prompts = [
	'I need to schedule a follow-up appointment.',
	'My MRN is MRN-100231 and date of birth is 1981-04-12.',
	'I would like to see Dr Chen-L sometime next week.',
	'What appointment do I already have on file?',
	'Thanks, that is all for today.',
];

async function sleep(ms: number): Promise<void> {
	await new Promise((r) => setTimeout(r, ms));
}

async function runSmoke(): Promise<void> {
	for (let attempt = 1; attempt <= 4; attempt++) {
		try {
			await runTemplateConversation({
				title: `cedar-health live smoke (${label}) attempt ${attempt}`,
				agents: buildAgents(model),
				defaultAgentId: 'coordinator',
				model,
				knowledge: knowledgeConfig,
				memoryService: new InMemoryMemoryService(),
				prompts,
			});
			return;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const rateLimited = message.includes('429') || message.includes('Resource exhausted');
			if (!rateLimited || attempt === 4) {
				throw err;
			}
			console.warn(`Rate limited on attempt ${attempt}; waiting 120s before retry...`);
			await sleep(120_000);
		}
	}
}

runSmoke().catch((err) => {
	console.error(err);
	process.exit(1);
});
