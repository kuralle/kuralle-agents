import { defineTool, type EffectTool, type ToolDefinition } from '@kuralle-agents/core';

type LegacyTool = {
	description: string;
	inputSchema: unknown;
	execute: (...args: unknown[]) => Promise<unknown> | unknown;
};

export function wireTools(source: object): { tools: Record<string, EffectTool> } {
	const tools: Record<string, EffectTool> = {};

	for (const [name, raw] of Object.entries(source as Record<string, LegacyTool>)) {
		const legacy = raw;
		tools[name] = defineTool({
			name,
			description: legacy.description,
			input: legacy.inputSchema as EffectTool['input'],
			execute: async (args) => legacy.execute(args),
		});
	}

	return { tools };
}

export function wireToolDefinition<TInput, TResult>(
	name: string,
	def: ToolDefinition<TInput, TResult>,
): { tools: Record<string, EffectTool> } {
	return wireTools({ [name]: def });
}
