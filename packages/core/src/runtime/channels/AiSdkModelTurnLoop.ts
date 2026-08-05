import { streamText, type LanguageModelUsage, type ModelMessage } from 'ai';
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

    // Whether the loop ended because the model was finished, rather than because it ran out of
    // steps. See the wrap-up call after the loop for why the difference matters.
    let endedDeliberately = false;

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
        if (finishReason !== 'tool-calls') {
          endedDeliberately = true;
          break;
        }

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

            const resultMessage = toolResultMessage(call, toolResult, ctx.limits?.maxToolResultTokens);
            messages.push(resultMessage);
            state.toolMessages.push(resultMessage);
          });
        } catch (error) {
          if (isControlFlowSignal(error)) {
            await ctx.attachInterruptContinuation(state.toolMessages);
          }
          throw error;
        }

        if (state.control || (await input.stopAfterToolResults?.(state) ?? false)) {
          endedDeliberately = true;
          break;
        }
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

    // The loop above exits one of two ways, and only one of them is the model being done.
    //
    // `finishReason !== 'tool-calls'` means the model stopped on its own — it spoke, and the
    // turn is complete. Running out of `maxSteps` while the last step was still calling tools
    // means the opposite: the model was mid-chain and never got to say anything. The turn then
    // ends with tool results and total silence.
    //
    // That is not hypothetical. `maxSteps` defaults to 5, and a specialist that grounds itself,
    // loads two skills, writes a piece and lints it has spent the budget before it ever
    // summarises. Observed live: ten tool calls, `finish`, and not one character of text — the
    // chat showed the tool cards and no reply.
    //
    // So a turn that hits the ceiling gets one wrap-up call with NO tools. Offering tools here
    // would just invite another call and reproduce the same silence one step later; withholding
    // them leaves the model nothing to do but write the answer it already has.
    //
    // Only for `speaking`. Typed extraction is deliberately mute and ends through
    // `stopAfterToolResults`, which counts as a deliberate exit — forcing prose there would put
    // stray text on a path whose whole point is not to produce any.
    if (!endedDeliberately && input.purpose === 'speaking' && !state.control) {
      await this.wrapUp(input, state, messages, emitToken);
    }
  }

  /** One final, tool-less call so a turn that exhausted its step budget still answers. */
  private async wrapUp(
    input: ModelTurnLoopInput,
    state: ModelTurnLoopState,
    messages: ModelMessage[],
    emitToken: (delta: string) => void,
  ): Promise<void> {
    const { ctx, model } = input;
    const callId = crypto.randomUUID();
    ctx.emit({
      channel: 'internal',
      type: 'model-call-start',
      payload: { callId, modelId: languageModelId(model), step: input.maxSteps },
    });

    const cached = applyPromptCache({
      model,
      sessionId: ctx.session.id,
      messages,
      stableSystem: input.system,
      volatileSystemBlocks: input.volatileSystemBlocks,
    });

    const result = streamText({
      model,
      ...(cached.system ? { system: cached.system } : {}),
      messages: cached.messages,
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

    const usage = await result.totalUsage;
    if (usage) state.usage = addTurnUsage(state.usage, usage);
    ctx.emit({
      channel: 'internal',
      type: 'model-call-end',
      payload: {
        callId,
        finishReason: await result.finishReason,
        ...(typeof usage?.inputTokens === 'number' ? { inputTokens: usage.inputTokens } : {}),
        ...(typeof usage?.outputTokens === 'number' ? { outputTokens: usage.outputTokens } : {}),
      },
    });
  }
}
