import { tool } from 'ai';
import { z } from 'zod';
import type { AgentConfig } from '../types/index.js';

export interface HandoffResult {
  __handoff: true;
  targetAgentId: string;
  targetAgent?: string;
  reason: string;
  summary?: string;
  message?: string;
}

export function createHandoffTool(
  availableAgents: AgentConfig[],
  currentAgentId?: string
) {
  const currentAgent = currentAgentId
    ? availableAgents.find(agent => agent.id === currentAgentId)
    : undefined;

  const handoffTargets = currentAgent?.handoffs;
  const targets = handoffTargets?.length
    ? availableAgents.filter(agent => handoffTargets.includes(agent.id))
    : availableAgents.filter(agent => agent.id !== currentAgentId);

  if (targets.length === 0) {
    return tool({
      description: 'No other agents available for handoff.',
      inputSchema: z.object({}),
      execute: async () => ({
        error: 'No handoff targets available',
      }),
    });
  }

  const agentDescriptions = targets
    .map(agent => `- **${agent.id}** (${agent.name}): ${agent.description ?? 'No description provided'}`)
    .join('\n');

  return tool({
    description:
      `Route the conversation to another specialized agent.\n` +
      `Routing is internal; do NOT mention this transfer to the user.\n\n` +
      `Available agents:\n${agentDescriptions}\n\n` +
      `Provide a clear reason for the route.`,
    inputSchema: z.object({
      targetAgentId: z.enum(targets.map(agent => agent.id) as [string, ...string[]])
        .describe('The ID of the agent to route to'),
      reason: z.string()
        .describe('Why you are routing - include relevant context'),
      summary: z.string().optional()
        .describe('Optional summary of what has been done so far'),
    }),
    execute: async ({ targetAgentId, reason, summary }) => {
      return {
        __handoff: true,
        targetAgentId,
        targetAgent: targetAgentId,
        reason,
        summary,
      } satisfies HandoffResult;
    },
  });
}

export function isHandoffResult(result: unknown): result is HandoffResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    '__handoff' in result &&
    (result as { __handoff: unknown }).__handoff === true &&
    ('targetAgentId' in result || 'targetAgent' in result)
  );
}
