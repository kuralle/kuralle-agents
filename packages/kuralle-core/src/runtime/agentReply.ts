import type { AgentConfig } from '../types/agentConfig.js';
import type { ReplyNode } from '../types/flow.js';
import type { AnyTool } from '../types/effectTool.js';
import type { RunState } from './durable/types.js';
import { buildToolSet } from '../tools/effect/defineTool.js';
import { deriveAgentShape } from './deriveAgent.js';
import { buildHostControlTools } from './hostControlTools.js';

export function buildAgentReplyNode(agent: AgentConfig, run?: RunState): ReplyNode {
  const shape = deriveAgentShape(agent);
  const tools: Record<string, AnyTool> = { ...agent.tools };

  if (shape.isAnsweringAgent && run) {
    Object.assign(tools, buildHostControlTools(agent, run));
  }

  const label = agent.name ?? agent.id;
  const instructions =
    agent.instructions ??
    (shape.isAnsweringAgent
      ? `You are ${label}. Help the user concisely. Do not mention internal routing or flows.`
      : '');

  return {
    kind: 'reply',
    id: `${agent.id}__host`,
    instructions,
    tools: Object.keys(tools).length > 0 ? buildToolSet(tools) : undefined,
    model: agent.model,
  };
}
