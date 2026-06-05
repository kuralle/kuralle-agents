import {
	createRuntime,
	MemoryStore,
	type AgentConfig,
	type HarnessStreamPart,
	type KnowledgeProviderConfig,
	type MemoryService,
} from '@kuralle-agents/core';
import type { LanguageModel } from 'ai';
import { mergeHarnessTools } from './harnessTools.js';

export async function runPlaygroundConversation(opts: {
	title: string;
	agents: AgentConfig[];
	defaultAgentId: string;
	prompts: string[];
	model: LanguageModel;
	knowledge?: KnowledgeProviderConfig;
	memoryService?: MemoryService;
	tools?: Record<string, import('@kuralle-agents/core').EffectTool>;
}): Promise<{ sessionId: string; transcript: string[] }> {
	const runtime = createRuntime({
		agents: opts.agents,
		defaultAgentId: opts.defaultAgentId,
		defaultModel: opts.model,
		sessionStore: new MemoryStore(),
		knowledge: opts.knowledge,
		memoryService: opts.memoryService,
		tools: opts.tools ?? mergeHarnessTools(opts.agents),
	});

	const sessionId = crypto.randomUUID();
	const transcript: string[] = [];

	console.log(opts.title);
	for (const input of opts.prompts) {
		const sep = '='.repeat(70);
		console.log(`\n${sep}\nUser: ${input}\n${sep}`);
		transcript.push(`user: ${input}`);

		const handle = runtime.run({ sessionId, input });
		let response = '';

		for await (const part of handle.events) {
			logPart(part);
			if (part.type === 'text-delta') response += part.delta;
		}

		await handle;
		const trimmed = response.trim();
		console.log(`Assistant: ${trimmed}`);
		transcript.push(`assistant: ${trimmed}`);
		await new Promise((r) => setTimeout(r, 2500));
	}

	console.log('\nRun complete.');
	return { sessionId, transcript };
}

function logPart(part: HarnessStreamPart): void {
	if (part.type === 'node-enter') console.log(`[Node] ${part.nodeName}`);
	if (part.type === 'flow-transition') console.log(`[Transition] ${part.from} -> ${part.to}`);
	if (part.type === 'flow-enter') console.log(`[Flow] ${part.flow}`);
	if (part.type === 'handoff') console.log(`[Handoff] ${part.targetAgent} (${part.reason ?? ''})`);
	if (part.type === 'tool-call') console.log(`[Tool call] ${part.toolName}`);
	if (part.type === 'tool-result') console.log(`[Tool result] ${part.toolName}`);
}
