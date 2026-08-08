import type { AgentConfig, AnyTool } from '@kuralle-agents/core';

export function mergeHarnessTools(agents: AgentConfig[]): Record<string, AnyTool> {
	const merged: Record<string, AnyTool> = {};
	for (const agent of agents) {
		if (agent.tools) {
			Object.assign(merged, agent.tools);
		}
	}
	return merged;
}
