import { tool as aiTool } from 'ai';
import { defineTool } from '@kuralle-agents/core';

export function wireTools(tools) {
  const effectTools = {};
  const aiTools = {};

  for (const [name, legacy] of Object.entries(tools)) {
    effectTools[name] = defineTool({
      name,
      description: legacy.description,
      input: legacy.inputSchema,
      execute: async (args) => legacy.execute(args),
    });
    aiTools[name] = aiTool({
      description: legacy.description,
      inputSchema: legacy.inputSchema,
    });
  }

  return { tools: aiTools, effectTools };
}

export function mergeHarnessTools(agents) {
  const merged = {};
  for (const agent of agents) {
    if (agent.effectTools) Object.assign(merged, agent.effectTools);
  }
  return merged;
}
