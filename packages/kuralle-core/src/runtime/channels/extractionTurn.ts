import { streamText, type JSONValue, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import type { ResolvedNode, TurnResult } from '../../types/channel.js';
import type { RunContext } from '../../types/run-context.js';
import type { ReplyNode } from '../../types/flow.js';
import { buildToolSet } from '../../tools/effect/index.js';
import { buildNodePrompt } from '../../flow/nodeBuilders.js';

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
): Promise<TurnResult> {
  const replyNode = node.node as ReplyNode;
  const system = node.prompt || buildNodePrompt(replyNode, ctx.runState.state);
  const messages: ModelMessage[] = [...ctx.runState.messages];
  const aiTools = resolveExtractionTools(node);
  const out: TurnResult = { text: '', toolResults: [] };

  for (let step = 0; step < maxSteps; step += 1) {
    const result = streamText({ model, system, messages, tools: aiTools, abortSignal: ctx.abortSignal });

    for await (const part of result.fullStream) {
      // Intentionally NOT handling 'text-delta' — extraction never speaks.
      if (part.type === 'error') {
        const err = (part as { error?: unknown }).error;
        const message = err instanceof Error ? err.message : String(err);
        ctx.emit({ type: 'error', error: message });
        throw err instanceof Error ? err : new Error(message);
      }
    }

    const finishReason = await result.finishReason;
    const response = await result.response;
    messages.push(...response.messages);

    if (finishReason !== 'tool-calls') {
      break;
    }

    const toolCalls = await result.toolCalls;
    for (const call of toolCalls) {
      const localTool = node.localTools?.[call.toolName];
      const toolResult = await ctx.tool(call.toolName, call.input, {
        toolCallId: call.toolCallId,
        ...(localTool && {
          def: localTool,
          toolCtx: {
            session: ctx.session,
            runState: ctx.runState,
            tool: ctx.tool.bind(ctx),
            now: ctx.now.bind(ctx),
            uuid: ctx.uuid.bind(ctx),
            emit: ctx.emit.bind(ctx),
          },
        }),
      });
      out.toolResults.push({
        name: call.toolName,
        args: call.input,
        result: toolResult,
        toolCallId: call.toolCallId,
      });
      messages.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: { type: 'json', value: toolResult as JSONValue },
          },
        ],
      });
    }
  }

  return out;
}

/** Tools available to the extraction turn = the node's submit tool only (built
 *  from the resolved node, independent of any driver-level tool defs) so text and
 *  voice resolve an identical toolset. */
function resolveExtractionTools(resolved: ResolvedNode): ToolSet | undefined {
  const aiTools: ToolSet = { ...resolved.tools };
  for (const [name, tool] of Object.entries(resolved.localTools ?? {})) {
    if (tool && !aiTools[name]) {
      Object.assign(aiTools, buildToolSet({ [name]: tool }));
    }
  }
  return Object.keys(aiTools).length > 0 ? aiTools : undefined;
}
