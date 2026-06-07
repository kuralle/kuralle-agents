import { defineTool } from '@kuralle-agents/core';

export function wireTools(source) {
  const tools = {};

  for (const [name, legacy] of Object.entries(source)) {
    tools[name] = defineTool({
      name,
      description: legacy.description,
      input: legacy.inputSchema,
      execute: async (args) => legacy.execute(args),
    });
  }

  return { tools };
}

export function mergeHarnessTools(agents) {
  const merged = {};
  for (const agent of agents) {
    if (agent.tools) Object.assign(merged, agent.tools);
  }
  return merged;
}
