import { isHandoffResult } from '../tools/handoff.js';
import { isFinalResult } from '../tools/final.js';
import { isEnterFlowResult } from '../tools/enterFlow.js';
import { isEscalateResult, isRecoverResult } from '../tools/controlResults.js';
import type { TurnControl } from '../types/channel.js';

export function classifyControl(result: unknown): TurnControl | undefined {
  if (isHandoffResult(result)) {
    return {
      type: 'handoff',
      target: result.targetAgentId,
      reason: result.reason,
    };
  }
  if (isEnterFlowResult(result)) {
    return { type: 'enterFlow', flowName: result.flowName, reason: result.reason };
  }
  if (isFinalResult(result)) {
    return { type: 'end', reason: result.text };
  }
  if (isEscalateResult(result)) {
    return { type: 'escalate', reason: result.reason };
  }
  if (isRecoverResult(result)) {
    return { type: 'recover', reason: result.reason };
  }
  return undefined;
}
