import type { AgentConfig } from '../types/agentConfig.js';

export interface DerivedAgentCapabilities {
  hasRoutes: boolean;
  hasFlows: boolean;
  hasFreeConversation: boolean;
  hasHandoffs: boolean;
  precedence: 'routes' | 'flows' | 'free';
}

export function deriveAgentCapabilities(agent: AgentConfig): DerivedAgentCapabilities {
  const hasRoutes = (agent.routes?.length ?? 0) > 0;
  const hasFlows = (agent.flows?.length ?? 0) > 0;
  const hasHandoffs = (agent.agents?.length ?? 0) > 0 || (agent.handoffs?.length ?? 0) > 0;
  const hasFreeConversation = true;

  const precedence: DerivedAgentCapabilities['precedence'] = hasRoutes
    ? 'routes'
    : hasFlows
      ? 'flows'
      : 'free';

  return {
    hasRoutes,
    hasFlows,
    hasFreeConversation,
    hasHandoffs,
    precedence,
  };
}

export function shouldRunHostSelector(agent: AgentConfig, activeFlow?: string, alwaysRoute?: boolean): boolean {
  if (activeFlow) {
    return false;
  }
  if (alwaysRoute) {
    return true;
  }
  const { hasRoutes, hasFlows } = deriveAgentCapabilities(agent);
  return hasRoutes || hasFlows;
}
