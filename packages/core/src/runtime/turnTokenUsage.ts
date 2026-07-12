import type { TurnResult } from '../types/channel.js';
import type { RunContext } from '../types/run-context.js';
import { TokenAccumulator } from './TokenAccumulator.js';

export const TOKEN_USAGE_STATE_KEY = '__tokenUsage';
export const LAST_PROMPT_TOKENS_KEY = '__lastPromptTokens';

export interface PersistedTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
}

function readPersistedUsage(state: Record<string, unknown>): PersistedTokenUsage | undefined {
  const saved = state[TOKEN_USAGE_STATE_KEY];
  if (!saved || typeof saved !== 'object') {
    return undefined;
  }
  const usage = saved as PersistedTokenUsage;
  if (
    typeof usage.inputTokens !== 'number' ||
    typeof usage.outputTokens !== 'number' ||
    typeof usage.totalTokens !== 'number'
  ) {
    return undefined;
  }
  return usage;
}

function hydrateAccumulator(state: Record<string, unknown>): TokenAccumulator {
  const acc = new TokenAccumulator();
  const saved = readPersistedUsage(state);
  if (saved) {
    acc.restoreCumulative(saved);
  }
  return acc;
}

/** Record real turn usage onto run state (survives across turns via persistence). */
export async function persistTurnUsageFromTurn(ctx: RunContext, turn: TurnResult): Promise<void> {
  if (!turn.usage) {
    return;
  }

  const acc = hydrateAccumulator(ctx.runState.state);
  const turnIndex = acc.turns.length + 1;
  acc.record({
    turn: turnIndex,
    inputTokens: turn.usage.inputTokens,
    outputTokens: turn.usage.outputTokens,
    totalTokens: turn.usage.totalTokens,
    cacheReadTokens: turn.usage.cacheReadTokens,
    latencyMs: 0,
  });

  ctx.runState.state[TOKEN_USAGE_STATE_KEY] = acc.cumulative;
  ctx.runState.state[LAST_PROMPT_TOKENS_KEY] = turn.usage.inputTokens;
  ctx.runState.updatedAt = Date.now();
  await ctx.runStore.putRunState(ctx.runState);
}

export function readLastPromptTokens(state: Record<string, unknown>): number | undefined {
  const value = state[LAST_PROMPT_TOKENS_KEY];
  return typeof value === 'number' ? value : undefined;
}

/** Token usage for a trace's `done` event: context-window size (last prompt tokens)
 *  + the session's cumulative generated tokens. Both undefined until a turn records usage. */
export function readTraceTokenUsage(
  state: Record<string, unknown>,
): { inputTokens?: number; outputTokens?: number } {
  const inputTokens = readLastPromptTokens(state);
  const saved = readPersistedUsage(state);
  return { inputTokens, outputTokens: saved?.outputTokens };
}