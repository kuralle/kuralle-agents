import { z } from 'zod';
import type { AgentConfig } from '../types/agentConfig.js';
import type { RunState } from './durable/types.js';
import type { AnyTool } from '../types/effectTool.js';
import type { Flow } from '../types/flow.js';
import { defineTool } from '../tools/effect/defineTool.js';
import { createEnterFlowTool } from '../tools/enterFlow.js';

export interface TransferTarget {
  id: string;
  descriptions: string[];
}

export function availableHostFlows(agent: AgentConfig, run: RunState): Flow[] {
  const flows = agent.flows ?? [];
  const completedRaw = run.state.__completedFlows;
  const completed = Array.isArray(completedRaw) ? (completedRaw as string[]) : [];
  return flows.filter(
    (flow) => !completed.includes(flow.name) && flow.name !== run.activeFlow,
  );
}

export function collectTransferTargets(agent: AgentConfig): TransferTarget[] {
  const byId = new Map<string, TransferTarget>();

  for (const route of agent.routes ?? []) {
    if (!route.agent) {
      continue;
    }
    const desc = `When: ${route.when}`;
    const existing = byId.get(route.agent);
    if (existing) {
      existing.descriptions.push(desc);
    } else {
      byId.set(route.agent, { id: route.agent, descriptions: [desc] });
    }
  }

  for (const child of agent.agents ?? []) {
    const desc = child.description ?? child.name ?? child.id;
    const existing = byId.get(child.id);
    if (existing) {
      if (!existing.descriptions.includes(desc)) {
        existing.descriptions.push(desc);
      }
    } else {
      byId.set(child.id, { id: child.id, descriptions: [desc] });
    }
  }

  for (const handoffId of agent.handoffs ?? []) {
    const child = agent.agents?.find((a) => a.id === handoffId);
    const desc = child?.description ?? child?.name ?? handoffId;
    const existing = byId.get(handoffId);
    if (existing) {
      if (!existing.descriptions.includes(desc)) {
        existing.descriptions.push(desc);
      }
    } else {
      byId.set(handoffId, { id: handoffId, descriptions: [desc] });
    }
  }

  return [...byId.values()];
}

function createTransferToAgentTool(targets: TransferTarget[]): AnyTool {
  const ids = targets.map((t) => t.id) as [string, ...string[]];
  const lines = targets.map((t) => `- ${t.id}: ${t.descriptions.join('; ')}`).join('\n');
  return defineTool({
    name: 'transfer_to_agent',
    description:
      'Transfer the conversation to a specialized agent. Routing is internal; do NOT mention this to the user.\n\n' +
      `Available targets:\n${lines}`,
    input: z.object({
      targetAgentId: z.enum(ids).describe('Target agent id'),
      reason: z.string().describe('Why this transfer — include relevant context'),
      summary: z.string().optional().describe('Optional summary of progress so far'),
    }),
    execute: async ({ targetAgentId, reason, summary }) => ({
      __handoff: true,
      targetAgentId,
      targetAgent: targetAgentId,
      reason,
      summary,
    }),
  });
}

export function buildHostControlTools(
  agent: AgentConfig,
  run: RunState,
): Record<string, AnyTool> {
  const tools: Record<string, AnyTool> = {};
  const flows = availableHostFlows(agent, run);
  if (flows.length > 0) {
    tools.enter_flow = createEnterFlowTool(flows);
  }
  const targets = collectTransferTargets(agent);
  if (targets.length > 0) {
    tools.transfer_to_agent = createTransferToAgentTool(targets);
  }
  return tools;
}

export function hasHostControlTargets(agent: AgentConfig, run: RunState): boolean {
  return (
    availableHostFlows(agent, run).length > 0 || collectTransferTargets(agent).length > 0
  );
}
