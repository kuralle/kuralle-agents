import type { AgentConfig, EffectTool } from '@kuralle-agents/core';

export function mergeHarnessTools(agents: AgentConfig[]): Record<string, EffectTool> {
	const merged: Record<string, EffectTool> = {};
	for (const agent of agents) {
		if (agent.effectTools) {
			Object.assign(merged, agent.effectTools);
		}
	}
	return merged;
}
