import { generateObject, type LanguageModel, type LanguageModelUsage } from 'ai';
import type { RunContext } from '../../types/run-context.js';
import { addTurnUsage, languageModelId } from './turnUsage.js';
import { persistTurnUsageFromTurn } from '../turnTokenUsage.js';

export interface InstrumentedGenerateObjectOptions<T> {
  model: LanguageModel;
  schema: import('zod').ZodType<T>;
  system?: string;
  messages?: import('ai').ModelMessage[];
  prompt?: string;
  temperature?: number;
  abortSignal?: AbortSignal;
  providerOptions?: Record<string, Record<string, import('ai').JSONValue>>;
  step?: number;
  /** Out-of-node control-path calls parent to the turn span, not a node span. */
  controlPath?: boolean;
}

/**
 * Wraps `generateObject` with `model-call-start` / `model-call-end` events so
 * control-path model calls are visible in traces and token reconciliation.
 */
export async function instrumentedGenerateObject<T>(
  ctx: Pick<RunContext, 'emit' | 'abortSignal'> & Partial<Pick<RunContext, 'runState' | 'runStore'>>,
  options: InstrumentedGenerateObjectOptions<T>,
): Promise<T> {
  const callId = crypto.randomUUID();
  const modelId = languageModelId(options.model);
  ctx.emit({
    channel: 'internal',
    type: 'model-call-start',
    payload: {
      callId,
      modelId,
      step: options.step ?? 0,
      ...(options.controlPath ? { controlPath: true } : {}),
    },
  });

  let stepUsage: LanguageModelUsage | undefined;
  let ended = false;
  try {
    const base = {
      model: options.model,
      schema: options.schema,
      ...(options.system !== undefined ? { system: options.system } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      abortSignal: options.abortSignal ?? ctx.abortSignal,
      ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}),
    };
    const { object, usage } =
      options.prompt !== undefined
        ? await generateObject({ ...base, prompt: options.prompt })
        : await generateObject({ ...base, messages: options.messages ?? [] });
    stepUsage = usage;
    ctx.emit({
      channel: 'internal',
      type: 'model-call-end',
      payload: {
        callId,
        finishReason: 'stop',
        ...(typeof stepUsage?.inputTokens === 'number' ? { inputTokens: stepUsage.inputTokens } : {}),
        ...(typeof stepUsage?.outputTokens === 'number' ? { outputTokens: stepUsage.outputTokens } : {}),
        ...(typeof stepUsage?.inputTokenDetails?.cacheReadTokens === 'number'
          ? { cacheReadTokens: stepUsage.inputTokenDetails.cacheReadTokens }
          : {}),
        ...(typeof stepUsage?.inputTokenDetails?.cacheWriteTokens === 'number'
          ? { cacheWriteTokens: stepUsage.inputTokenDetails.cacheWriteTokens }
          : {}),
      },
    });
    ended = true;
    if (stepUsage && ctx.runState && ctx.runStore) {
      await persistTurnUsageFromTurn(
        { runState: ctx.runState, runStore: ctx.runStore },
        { usage: addTurnUsage(undefined, stepUsage) },
      );
    }
    return object;
  } catch (err) {
    if (!ended) {
      ctx.emit({
        channel: 'internal',
        type: 'model-call-end',
        payload: {
          callId,
          finishReason: 'error',
          ...(typeof stepUsage?.inputTokens === 'number' ? { inputTokens: stepUsage.inputTokens } : {}),
          ...(typeof stepUsage?.outputTokens === 'number' ? { outputTokens: stepUsage.outputTokens } : {}),
        },
      });
    }
    throw err;
  }
}
