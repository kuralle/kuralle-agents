import type { Limits } from '../../types/guardrails.js';
import type { RunState } from '../durable/types.js';

const TURN_COUNT_KEY = '__agentTurnCount';

export class LimitsExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LimitsExceededError';
  }
}

export function readTurnCount(run: RunState): number {
  const value = run.state[TURN_COUNT_KEY];
  return typeof value === 'number' ? value : 0;
}

export function incrementTurnCount(run: RunState): number {
  const next = readTurnCount(run) + 1;
  run.state[TURN_COUNT_KEY] = next;
  run.updatedAt = Date.now();
  return next;
}

export function assertWithinTurnLimit(run: RunState, limits?: Limits): void {
  const maxTurns = limits?.maxTurns;
  if (maxTurns == null) {
    return;
  }
  const turns = readTurnCount(run);
  if (turns > maxTurns) {
    throw new LimitsExceededError(`maxTurns exceeded (${maxTurns})`);
  }
}

export function resolveMaxSteps(limits: Limits | undefined, fallback: number): number {
  return limits?.maxSteps ?? limits?.toolMaxSteps ?? fallback;
}
