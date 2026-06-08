import type { AgentConfig, Instructions } from '../types/agentConfig.js';

export interface DerivedAgentCapabilities {
  hasRoutes: boolean;
  hasFlows: boolean;
  hasFreeConversation: boolean;
  hasHandoffs: boolean;
  precedence: 'routes' | 'flows' | 'free';
}

export interface AgentShape {
  hasDispatchTargets: boolean;
  hasLocalProcedure: boolean;
  hasLocalAnsweringSurface: boolean;
  isAnsweringAgent: boolean;
  isPureDispatcher: boolean;
}

function hasPopulatedInstructions(instructions?: Instructions): boolean {
  if (instructions === undefined) {
    return false;
  }
  if (typeof instructions === 'string') {
    return instructions.trim().length > 0;
  }
  return true;
}

export function hasLocalAnsweringSurface(agent: AgentConfig): boolean {
  if (hasPopulatedInstructions(agent.instructions)) {
    return true;
  }
  if (agent.tools && Object.keys(agent.tools).length > 0) {
    return true;
  }
  if (agent.globalTools && Object.keys(agent.globalTools).length > 0) {
    return true;
  }
  if (agent.knowledge) {
    return true;
  }
  if (agent.memory) {
    return true;
  }
  if (agent.skills) {
    return true;
  }
  if (agent.workspace) {
    return true;
  }
  return false;
}

export function hasDispatchTargets(agent: AgentConfig): boolean {
  const routes = agent.routes ?? [];
  if (routes.some((route) => route.agent || route.flow)) {
    return true;
  }
  if ((agent.agents?.length ?? 0) > 0) {
    return true;
  }
  if ((agent.handoffs?.length ?? 0) > 0) {
    return true;
  }
  return false;
}

export function deriveAgentShape(agent: AgentConfig): AgentShape {
  const hasLocalProcedure = (agent.flows?.length ?? 0) > 0;
  const answeringSurface = hasLocalAnsweringSurface(agent);
  const dispatchTargets = hasDispatchTargets(agent);
  const isAnsweringAgent = hasLocalProcedure || answeringSurface;
  const isPureDispatcher = dispatchTargets && !isAnsweringAgent;

  return {
    hasDispatchTargets: dispatchTargets,
    hasLocalProcedure,
    hasLocalAnsweringSurface: answeringSurface,
    isAnsweringAgent,
    isPureDispatcher,
  };
}

export function deriveAgentCapabilities(agent: AgentConfig): DerivedAgentCapabilities {
  const shape = deriveAgentShape(agent);
  const hasRoutes = (agent.routes?.length ?? 0) > 0;
  const hasFlows = shape.hasLocalProcedure;
  const hasHandoffs = (agent.agents?.length ?? 0) > 0 || (agent.handoffs?.length ?? 0) > 0;

  const precedence: DerivedAgentCapabilities['precedence'] = hasRoutes
    ? 'routes'
    : hasFlows
      ? 'flows'
      : 'free';

  return {
    hasRoutes,
    hasFlows,
    hasFreeConversation: shape.isAnsweringAgent,
    hasHandoffs,
    precedence,
  };
}
