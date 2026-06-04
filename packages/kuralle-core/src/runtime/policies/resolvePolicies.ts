import type { AgentConfig } from '../../types/agentConfig.js';
import type { RefinementCapability } from '../../capabilities/RefinementCapability.js';
import type { ValidationCapability } from '../../capabilities/ValidationCapability.js';
import type { InputProcessor, OutputProcessor } from '../../types/processors.js';
import type { Limits } from '../../types/guardrails.js';
import { createToolEnforcer, type ToolEnforcer } from '../../guards/ToolEnforcer.js';

export interface ResolvedAgentPolicies {
  inputProcessors: InputProcessor[];
  outputProcessors: OutputProcessor[];
  refinementPolicies: RefinementCapability[];
  validationPolicies: ValidationCapability[];
  limits?: Limits;
  enforcer?: ToolEnforcer;
}

export function resolveAgentPolicies(agent: AgentConfig): ResolvedAgentPolicies {
  const guardrails = agent.guardrails;
  const enforcementRules = guardrails?.enforcement ?? [];

  return {
    inputProcessors: guardrails?.input ?? [],
    outputProcessors: guardrails?.output ?? [],
    refinementPolicies: agent.refine ?? [],
    validationPolicies: agent.validate ?? [],
    limits: agent.limits,
    enforcer: enforcementRules.length > 0 ? createToolEnforcer(enforcementRules) : undefined,
  };
}
