import type { AgentConfig } from '../types/agentConfig.js';
import type { ReplyNode } from '../types/flow.js';
import type { AnyTool } from '../types/effectTool.js';
import type { RunState } from './durable/types.js';
import { buildToolSet } from '../tools/effect/defineTool.js';
import { createEnterFlowTool } from '../tools/enterFlow.js';

/** Flows the host turn may still enter: agent flows minus already-completed and
 *  the currently active one. Mirrors the exclusion in `select.ts`. */
function availableHostFlows(agent: AgentConfig, run: RunState) {
  const flows = agent.flows ?? [];
  const completedRaw = run.state.__completedFlows;
  const completed = Array.isArray(completedRaw) ? (completedRaw as string[]) : [];
  return flows.filter((flow) => !completed.includes(flow.name) && flow.name !== run.activeFlow);
}

export function buildAgentReplyNode(agent: AgentConfig, run?: RunState): ReplyNode {
  const label = agent.name ?? agent.id;
  const instructions =
    agent.instructions ??
    `You are ${label}. Help the user concisely. Do not mention internal routing or flows.`;

  const tools: Record<string, AnyTool> = { ...agent.tools };

  // routing.mode:'tools' — fold flow entry into the speaking turn as an
  // `enter_flow` tool instead of paying the upfront `generateObject` selector.
  if (agent.routing?.mode === 'tools' && run) {
    const available = availableHostFlows(agent, run);
    if (available.length > 0) {
      const enterFlow = createEnterFlowTool(available);
      tools[enterFlow.name] = enterFlow;
    }
  }

  return {
    kind: 'reply',
    id: `${agent.id}__host`,
    instructions,
    tools: Object.keys(tools).length > 0 ? buildToolSet(tools) : undefined,
    model: agent.model,
  };
}
