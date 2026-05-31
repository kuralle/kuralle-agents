import { tool as aiTool, type ToolSet } from 'ai';
import { defineTool, type EffectTool } from '@kuralle-agents/core';

type LegacyTool = {
	description: string;
	inputSchema: unknown;
	execute: (...args: unknown[]) => Promise<unknown> | unknown;
};

export function wireTools(tools: object): {
	tools: ToolSet;
	effectTools: Record<string, EffectTool>;
} {
	const effectTools: Record<string, EffectTool> = {};
	const aiTools: ToolSet = {};

	for (const [name, raw] of Object.entries(tools as Record<string, LegacyTool>)) {
		const legacy = raw;
		effectTools[name] = defineTool({
			name,
			description: legacy.description,
			input: legacy.inputSchema as EffectTool['input'],
			execute: async (args) => legacy.execute(args),
		});
		aiTools[name] = aiTool({
			description: legacy.description,
			inputSchema: legacy.inputSchema as Parameters<typeof aiTool>[0]['inputSchema'],
		}) as ToolSet[string];
	}

	return { tools: aiTools, effectTools };
}
