import type { LanguageModel } from 'ai';
import type { AgentConfig } from '../types/agentConfig.js';
import type { TurnControl } from '../types/channel.js';
import type { RunState } from './durable/types.js';
import {
  classifyHostTarget,
  type HostGuardVerdict,
  type ClassifyHostOptions,
} from './select.js';
import { availableHostFlows, collectTransferTargets } from './hostControlTools.js';

export type { HostGuardVerdict };

export function startHostControlGuard(options: {
  agent: AgentConfig;
  run: RunState;
  model: LanguageModel;
  classify?: (opts: ClassifyHostOptions) => Promise<HostGuardVerdict>;
}): Promise<HostGuardVerdict> {
  const classify = options.classify ?? classifyHostTarget;
  return classify({
    agent: options.agent,
    run: options.run,
    model: options.model,
    allowKeep: true,
  });
}

export function isValidControl(control: TurnControl, agent: AgentConfig, run: RunState): boolean {
  switch (control.type) {
    case 'enterFlow': {
      const flows = availableHostFlows(agent, run);
      return flows.some((f) => f.name === control.flowName);
    }
    case 'handoff':
      return collectTransferTargets(agent).some((t) => t.id === control.target);
    case 'end':
    case 'escalate':
    case 'recover':
      return true;
    default:
      return false;
  }
}

export function isValidGuardVerdict(
  verdict: HostGuardVerdict,
  agent: AgentConfig,
  run: RunState,
): boolean {
  if (verdict.action === 'keep') {
    return true;
  }
  if (verdict.action === 'enterFlow' && verdict.flowName) {
    return availableHostFlows(agent, run).some((f) => f.name === verdict.flowName);
  }
  if (verdict.action === 'transfer' && verdict.targetAgentId) {
    return collectTransferTargets(agent).some((t) => t.id === verdict.targetAgentId);
  }
  return false;
}

export function guardVerdictToControl(verdict: HostGuardVerdict): TurnControl | undefined {
  if (verdict.action === 'enterFlow' && verdict.flowName) {
    return { type: 'enterFlow', flowName: verdict.flowName, reason: verdict.reason };
  }
  if (verdict.action === 'transfer' && verdict.targetAgentId) {
    return { type: 'handoff', target: verdict.targetAgentId, reason: verdict.reason };
  }
  return undefined;
}

/**
 * Main model control wins when valid. The guard is a forgot-to-route net, NOT a
 * second-guesser: it only overrides when the answering model produced neither a
 * control tool NOR a substantive answer (`mainAnswered`). If the model answered,
 * the answer stands — a guard verdict must not hijack a correct keep answer
 * (which caused observed mis-routes of Q&A turns into flows).
 */
export function resolveHostControl(
  mainControl: TurnControl | undefined,
  guardVerdict: HostGuardVerdict | undefined,
  agent: AgentConfig,
  run: RunState,
  mainAnswered: boolean,
): TurnControl | undefined {
  if (mainControl && isValidControl(mainControl, agent, run)) {
    return mainControl;
  }
  if (
    !mainAnswered &&
    guardVerdict &&
    guardVerdict.action !== 'keep' &&
    isValidGuardVerdict(guardVerdict, agent, run)
  ) {
    return guardVerdictToControl(guardVerdict);
  }
  return undefined;
}
