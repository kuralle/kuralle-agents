import type { AgentConfig, EffectTool } from '@kuralle-agents/core';

export function mergeHarnessTools(agents: AgentConfig[]): Record<string, EffectTool> {
	const merged: Record<string, EffectTool> = {};
	for (const agent of agents) {
		if (agent.tools) {
			Object.assign(merged, agent.tools);
		}
	}
	return merged;
}
