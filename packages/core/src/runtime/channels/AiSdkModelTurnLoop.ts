import { streamText, type LanguageModelUsage } from 'ai';
import type { ModelTurnLoop, ModelTurnLoopInput, ModelTurnLoopState } from './ModelTurnLoop.js';
import { applyPromptCache } from '../promptCache.js';
import { addTurnUsage, languageModelId } from './turnUsage.js';
import { dispatchModelToolCalls, toolResultMessage } from './executeModelTool.js';
import { isControlFlowSignal } from '../controlFlowSignal.js';

/** Built-in AI SDK implementation of the inner model/tool loop. */
export class AiSdkModelTurnLoop implements ModelTurnLoop {
  async run(
    input: ModelTurnLoopInput,
    state: ModelTurnLoopState,
    emitToken: (delta: string) => void,
  ): Promise<void> {
    const { ctx, model, maxSteps } = input;
    const messages = [...input.messages];

    for (let step = 0; step < maxSteps; step += 1) {
      const cached = applyPromptCache({
        model,
        sessionId: ctx.session.id,
        messages,
        tools: input.tools,
        stableSystem: input.system,
        volatileSystemBlocks: input.volatileSystemBlocks,
      });
      const callId = crypto.randomUUID();
      const modelId = languageModelId(model);
      ctx.emit({
        channel: 'internal',
        type: 'model-call-start',
        payload: { callId, modelId, step },
      });
      let stepUsage: LanguageModelUsage | undefined;
      let finishReason: string | undefined;
      let ended = false;
      try {
        const result = streamText({
          model,
          ...(cached.system ? { system: cached.system } : {}),
          messages: cached.messages,
          tools: cached.tools ?? input.tools,
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          abortSignal: ctx.abortSignal,
          ...(cached.providerOptions ? { providerOptions: cached.providerOptions } : {}),
        });

        for await (const part of result.fullStream) {
          if (part.type === 'text-delta') emitToken(part.text);
          if (part.type === 'error') {
            const error = (part as { error?: unknown }).error;
            const message = error instanceof Error ? error.message : String(error);
            ctx.emit({ channel: 'client', type: 'error', payload: { error: message } });
            throw error instanceof Error ? error : new Error(message);
          }
        }

        finishReason = await result.finishReason;
        const response = await result.response;
        if (result.totalUsage) {
          stepUsage = await result.totalUsage;
          if (stepUsage) state.usage = addTurnUsage(state.usage, stepUsage);
        }

        ctx.emit({
          channel: 'internal',
          type: 'model-call-end',
          payload: {
            callId,
            ...(finishReason !== undefined ? { finishReason } : {}),
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

        messages.push(...response.messages);
        if (finishReason !== 'tool-calls') break;

        state.toolMessages.push(...response.messages);
        const toolCalls = await result.toolCalls;
        const mergedTools = {
          ...ctx.globalTools,
          ...(ctx.workingMemoryTools ?? {}),
          ...input.node.localTools,
        };
        try {
          await dispatchModelToolCalls(ctx, toolCalls, mergedTools, ({ call, outcome }) => {
            const { result: toolResult, control, failed } = outcome;
            state.toolResults.push({
              name: call.toolName,
              args: call.input,
              result: toolResult,
              toolCallId: call.toolCallId,
            });
            state.toolCallsMade.push({
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              args: call.input,
              result: toolResult,
              success: !failed,
              timestamp: Date.now(),
            });
            state.control ??= control;

            const resultMessage = toolResultMessage(call, toolResult);
            messages.push(resultMessage);
            state.toolMessages.push(resultMessage);
          });
        } catch (error) {
          if (isControlFlowSignal(error)) {
            await ctx.attachInterruptContinuation(state.toolMessages);
          }
          throw error;
        }

        if (state.control || (await input.stopAfterToolResults?.(state) ?? false)) break;
      } catch (error) {
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
        throw error;
      }
    }
  }
}
