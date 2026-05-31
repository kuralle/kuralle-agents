import { isHandoffResult } from '../tools/handoff.js';
import { isFinalResult } from '../tools/final.js';
import type { TurnControl } from '../types/channel.js';

export function classifyControl(result: unknown): TurnControl | undefined {
  if (isHandoffResult(result)) {
    return {
      type: 'handoff',
      target: result.targetAgentId,
      reason: result.reason,
    };
  }
  if (isFinalResult(result)) {
    return { type: 'end', reason: result.text };
  }
  return undefined;
}
