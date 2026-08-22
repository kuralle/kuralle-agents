import { streamText, type LanguageModelUsage, type ModelMessage, type ToolSet } from 'ai';
import type { ModelTurnLoop, ModelTurnLoopInput, ModelTurnLoopState } from './ModelTurnLoop.js';
import { applyPromptCache } from '../promptCache.js';
import { addTurnUsage, languageModelId } from './turnUsage.js';
import { dispatchModelToolCalls, toolResultMessage } from './executeModelTool.js';
import { isControlFlowSignal } from '../controlFlowSignal.js';
import { assertNoSystemRoleInModelMessages } from '../modelMessagesGuard.js';
import type { TurnIncompletePayload } from '../../types/stream.js';

/** Sorted tool names for stable provider prompt-cache hashing. */
export function deriveToolOrder(tools: ToolSet | undefined): readonly string[] | undefined {
  if (!tools) return undefined;
  const names = Object.keys(tools);
  if (names.length === 0) return undefined;
  return names.slice().sort();
}

/** Built-in AI SDK implementation of the inner model/tool loop. */
export class AiSdkModelTurnLoop implements ModelTurnLoop {
  async run(
    input: ModelTurnLoopInput,
    state: ModelTurnLoopState,
    emitToken: (delta: string) => void,
  ): Promise<void> {
    const { ctx, model, maxSteps } = input;
    const messages = [...input.messages];

    // Why the loop ended, distinct from "did we run out of steps". See the wrap-up call
    // after the loop for why that distinction matters: only 'step-budget' gets one.
    let exitReason: 'stop' | 'abnormal' | 'step-budget' | 'control' = 'step-budget';

    for (let step = 0; step < maxSteps; step += 1) {
      let stepHadText = false;
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
        assertNoSystemRoleInModelMessages(cached.messages, 'streamText');
        const modelTools = cached.tools ?? input.tools;
        const result = streamText({
          model,
          ...(cached.system ? { system: cached.system } : {}),
          messages: cached.messages,
          tools: modelTools,
          toolOrder: deriveToolOrder(modelTools),
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          abortSignal: ctx.abortSignal,
          ...(cached.providerOptions ? { providerOptions: cached.providerOptions } : {}),
        });

        for await (const part of result.stream) {
          if (part.type === 'text-delta') {
            if (part.text) stepHadText = true;
            emitToken(part.text);
          }
          if (part.type === 'error') {
            const error = (part as { error?: unknown }).error;
            const message = error instanceof Error ? error.message : String(error);
            ctx.emit({ channel: 'client', type: 'error', payload: { error: message } });
            throw error instanceof Error ? error : new Error(message);
          }
        }

        finishReason = await result.finishReason;
        const response = (await result.finalStep).response;
        stepUsage = await result.usage;
        if (stepUsage) state.usage = addTurnUsage(state.usage, stepUsage);

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
        if (finishReason === 'stop') {
          exitReason = 'stop';
          break;
        }
        if (finishReason !== 'tool-calls') {
          const reason = (finishReason ?? 'other') as TurnIncompletePayload['reason'];
          state.incomplete = { reason, step };
          ctx.emit({
            channel: 'internal',
            type: 'turn-incomplete',
            payload: { reason, step, hadText: stepHadText },
          });
          exitReason = 'abnormal';
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
          exitReason = 'control';
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

    // The loop above exits one of four ways, and only running out of steps warrants a wrap-up.
    //
    // `stop` means the model finished on its own — it spoke, and the turn is complete.
    // `abnormal` (`length` / `content-filter` / `error` / `other`) means the model was cut off,
    // not that it chose to stop; re-calling it tool-less reproduces the same ceiling one step
    // later (`length` most of all — the model would just hit the output cap again mid-sentence).
    // `control` is a deliberate handoff/end/escalation and must not be second-guessed with a
    // free-form reply. Only `step-budget` — running out of `maxSteps` while the last step was
    // still calling tools — means the model was mid-chain and never got to say anything.
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
    // `stopAfterToolResults`, which counts as a `control` exit — forcing prose there would put
    // stray text on a path whose whole point is not to produce any.
    if (exitReason === 'step-budget' && input.purpose === 'speaking' && !state.control) {
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

    assertNoSystemRoleInModelMessages(cached.messages, 'streamText wrapUp');
    const result = streamText({
      model,
      ...(cached.system ? { system: cached.system } : {}),
      messages: cached.messages,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      abortSignal: ctx.abortSignal,
      ...(cached.providerOptions ? { providerOptions: cached.providerOptions } : {}),
    });

    for await (const part of result.stream) {
      if (part.type === 'text-delta') emitToken(part.text);
      if (part.type === 'error') {
        const error = (part as { error?: unknown }).error;
        const message = error instanceof Error ? error.message : String(error);
        ctx.emit({ channel: 'client', type: 'error', payload: { error: message } });
        throw error instanceof Error ? error : new Error(message);
      }
    }

    const usage = await result.usage;
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
