import { defineAgent } from '../../authoring/defineAgent.js';
import type { AgentConfig, Instructions } from '../../types/agentConfig.js';
import { createFlowBuilderTools } from './tools.js';
import { FLOW_BUILDER_AUTHORING_PLAYBOOK } from './playbook.js';
import type { FlowBuilderHost } from './types.js';

export interface CreateFlowBuilderAgentOptions extends AgentConfig {
  /** Host-specific policy composed after the shared playbook. */
  surfaceInstructions: string;
  host: FlowBuilderHost;
}

async function renderInstructions(value: Instructions): Promise<string> {
  if (typeof value === 'string') return value;
  if (typeof value === 'function') return renderInstructions(await value({ state: {} }));
  return value.render();
}

export function composeFlowBuilderInstructions(
  surfaceInstructions: string,
  extra?: Instructions,
): Instructions {
  const head = `${FLOW_BUILDER_AUTHORING_PLAYBOOK}\n\n## Surface policy\n\n${surfaceInstructions}`;
  if (extra === undefined) return head;
  if (typeof extra === 'string') return `${head}\n\n${extra}`;
  return async (ctx) => {
    const resolved = typeof extra === 'function' ? await extra(ctx) : extra;
    return `${head}\n\n${await renderInstructions(resolved)}`;
  };
}

export function createFlowBuilderAgent(options: CreateFlowBuilderAgentOptions): AgentConfig {
  const { surfaceInstructions, host, instructions, tools, ...config } = options;
  return defineAgent({
    ...config,
    instructions: composeFlowBuilderInstructions(surfaceInstructions, instructions),
    tools: {
      ...tools,
      ...createFlowBuilderTools(host),
    },
  });
}
