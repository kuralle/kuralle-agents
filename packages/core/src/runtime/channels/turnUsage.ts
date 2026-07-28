import type { LanguageModelUsage } from 'ai';
import type { TurnUsageSnapshot } from '../../types/channel.js';

export function addTurnUsage(
  current: TurnUsageSnapshot | undefined,
  usage: LanguageModelUsage,
): TurnUsageSnapshot {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const totalTokens = usage.totalTokens ?? inputTokens + outputTokens;
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  if (!current) {
    return {
      inputTokens,
      outputTokens,
      totalTokens,
      cacheReadTokens,
      cacheWriteTokens,
      contextTokens: inputTokens,
    };
  }
  return {
    inputTokens: current.inputTokens + inputTokens,
    outputTokens: current.outputTokens + outputTokens,
    totalTokens: current.totalTokens + totalTokens,
    cacheReadTokens: (current.cacheReadTokens ?? 0) + cacheReadTokens,
    cacheWriteTokens: (current.cacheWriteTokens ?? 0) + cacheWriteTokens,
    // PEAK, not last. contextTokens answers "how much window did this turn occupy", and a
    // multi-step turn occupies the largest single prompt it sent — not the final one, and
    // not the sum. Assigning the last step made a 24,437-token turn report 2,232 because
    // its tail step was a small extraction call.
    contextTokens: Math.max(current.contextTokens ?? 0, inputTokens),
  };
}

/** Best-effort model id for `llm:` span names; stubs without `modelId` report `unknown`. */
export function languageModelId(model: { modelId?: unknown } | unknown): string {
  const id = (model as { modelId?: unknown } | null | undefined)?.modelId;
  return typeof id === 'string' && id.length > 0 ? id : 'unknown';
}
