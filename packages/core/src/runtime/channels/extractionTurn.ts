import { streamText, type LanguageModel, type LanguageModelUsage, type ModelMessage } from 'ai';
import { executeModelToolCall, toolResultMessage } from './executeModelTool.js';
import type { ResolvedNode, TurnResult, TurnUsageSnapshot } from '../../types/channel.js';
import type { RunContext } from '../../types/run-context.js';
import type { ReplyNode } from '../../types/flow.js';
import type { AnyTool } from '../../types/effectTool.js';
import { buildNodePrompt, composeSystem } from '../../flow/nodeBuilders.js';
import { systemNoteBlocks } from '../systemNotes.js';
import { applyPromptCache } from '../promptCache.js';
import { resolveNodeTools } from './resolveNodeTools.js';
import { addTurnUsage, languageModelId } from './turnUsage.js';

/**
 * Shared, NON-SPEAKING field extraction for `collect` nodes, used by every
 * ChannelDriver so text and voice behave identically. It runs the model with the
 * node's submit tool to pull structured fields, but never emits a `text-delta`,
 * never emits `turn-end`, and never appends model prose — the model's words are
 * discarded by construction. The user-facing question is emitted deterministically
 * by the flow engine (`CollectNode.ask`), not by the model. This is the structural
 * invariant that stops a collect turn from narrating outcomes that contradict
 * flow state, regardless of which model is used.
 */
export async function runSilentExtraction(
  node: ResolvedNode,
  ctx: RunContext,
  model: LanguageModel,
  maxSteps: number,
  agentToolDefs: Record<string, AnyTool> = {},
): Promise<TurnResult> {
  const replyNode = node.node as ReplyNode;
  const nodeSystem = node.prompt || buildNodePrompt(replyNode, ctx.runState.state);
  const stableSystem = composeSystem(
    ctx.baseInstructions,
    nodeSystem,
    ctx.runState.state,
    ctx.skillPrompt,
    ctx.workingMemoryPrompt,
  );
  const volatileSystemBlocks = systemNoteBlocks(ctx.runState);
  const messages: ModelMessage[] = [...ctx.runState.messages];
  const aiTools = resolveNodeTools(node, ctx, agentToolDefs);
  const out: TurnResult = { text: '', toolResults: [] };
  let turnUsage: TurnUsageSnapshot | undefined;

  for (let step = 0; step < maxSteps; step += 1) {
    const cached = applyPromptCache({
      model,
      sessionId: ctx.session.id,
      messages,
      tools: aiTools,
      stableSystem,
      volatileSystemBlocks,
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
        tools: cached.tools ?? aiTools,
        temperature: 0,
        abortSignal: ctx.abortSignal,
        ...(cached.providerOptions ? { providerOptions: cached.providerOptions } : {}),
      });

      for await (const part of result.fullStream) {
        // Intentionally NOT handling 'text-delta' — extraction never speaks.
        if (part.type === 'error') {
          const err = (part as { error?: unknown }).error;
          const message = err instanceof Error ? err.message : String(err);
          ctx.emit({ channel: 'client', type: 'error', payload: { error: message } });
          throw err instanceof Error ? err : new Error(message);
        }
      }

      finishReason = await result.finishReason;
      const response = await result.response;
      messages.push(...response.messages);
      if (result.totalUsage) {
        stepUsage = await result.totalUsage;
        if (stepUsage) {
          turnUsage = addTurnUsage(turnUsage, stepUsage);
        }
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

      if (finishReason !== 'tool-calls') {
        break;
      }

      const toolCalls = await result.toolCalls;
      let submitFailed = false;
      for (const call of toolCalls) {
        const { result: toolResult, failed } = await executeModelToolCall(
          ctx,
          { toolName: call.toolName, input: call.input, toolCallId: call.toolCallId },
          node.localTools,
        );
        if (
          failed &&
          call.toolName.startsWith('submit_') &&
          call.toolName.endsWith('_data')
        ) {
          submitFailed = true;
        }
        out.toolResults.push({
          name: call.toolName,
          args: call.input,
          result: toolResult,
          toolCallId: call.toolCallId,
        });
        messages.push(
          toolResultMessage(
            { toolName: call.toolName, input: call.input, toolCallId: call.toolCallId },
            toolResult,
          ),
        );
      }

      const submitReturned = toolCalls.some(
        (call) => call.toolName.startsWith('submit_') && call.toolName.endsWith('_data'),
      );
      if (
        submitReturned &&
        !submitFailed &&
        (node.extractionSatisfied?.(out.toolResults) ?? false)
      ) {
        break;
      }
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

  if (turnUsage && turnUsage.totalTokens > 0) {
    out.usage = turnUsage;
  }

  return out;
}
