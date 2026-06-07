import type { AgentConfig } from '../types/agentConfig.js';
import type { ReplyNode } from '../types/flow.js';
import { buildToolSet } from '../tools/effect/defineTool.js';

export function buildAgentReplyNode(agent: AgentConfig): ReplyNode {
  const label = agent.name ?? agent.id;
  const instructions =
    agent.instructions ??
    `You are ${label}. Help the user concisely. Do not mention internal routing or flows.`;

  return {
    kind: 'reply',
    id: `${agent.id}__host`,
    instructions,
    tools: agent.tools ? buildToolSet(agent.tools) : undefined,
    model: agent.model,
  };
}
