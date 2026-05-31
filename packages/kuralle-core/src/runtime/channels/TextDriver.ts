import type { TurnResult, UserSignal, ResolvedNode } from '../../types/channel.js';
import type { RunContext } from '../../types/run-context.js';
import type { ChannelDriver } from '../../types/channel.js';
import type { ToolCallRecord } from '../../types/session.js';
import { streamText, generateObject, type JSONValue, type ModelMessage, type ToolSet } from 'ai';
import type { ReplyNode, DecideNode } from '../../types/flow.js';
import { buildNodePrompt, resolveInstructions } from '../../flow/nodeBuilders.js';
import { buildToolSet } from '../../tools/effect/index.js';
import type { Tool, AnyTool } from '../../types/effectTool.js';
import { classifyControl } from '../../flow/classifyControl.js';
import { consumePendingUserInput } from './inputBuffer.js';
import { applyPreTurnPolicies, applyPostTurnPolicies } from '../policies/agentTurn.js';
import { resolveMaxSteps } from '../policies/limits.js';
import { appendGatherBlocks, runGatherPhase } from '../grounding/index.js';
import { z } from 'zod';

export interface TextDriverConfig {
  toolDefs?: Record<string, AnyTool>;
  maxSteps?: number;
}

export class TextDriver implements ChannelDriver {
  private readonly toolDefs: Record<string, AnyTool>;
  private readonly maxSteps: number;

  constructor(config: TextDriverConfig = {}) {
    this.toolDefs = config.toolDefs ?? {};
    this.maxSteps = config.maxSteps ?? 5;
  }

  async runAgentTurn(node: ResolvedNode, ctx: RunContext): Promise<TurnResult> {
    const replyNode = node.node as ReplyNode;
    if (replyNode.kind !== 'reply') {
      throw new Error(`TextDriver.runAgentTurn expects a reply node, got ${replyNode.kind}`);
    }

    const preTurn = await applyPreTurnPolicies(ctx);
    if (!preTurn.proceed) {
      const blocked = preTurn.blockedMessage ?? 'Input blocked by guardrails';
      ctx.emit({ type: 'text-delta', text: blocked });
      ctx.emit({ type: 'turn-end' });
      return { text: blocked, toolResults: [] };
    }

    const gather = await runGatherPhase(ctx);
    const out: TurnResult = { text: '', toolResults: [] };
    const model = replyNode.model ?? ctx.model;
    const baseSystem = node.prompt || buildNodePrompt(replyNode, ctx.runState.state);
    const system = appendGatherBlocks(baseSystem, [gather.retrievalBlock, gather.memoryBlock]);
    const messages: ModelMessage[] = [...ctx.runState.messages];
    const aiTools = this.resolveTools(node);
    const maxSteps = resolveMaxSteps(ctx.limits, this.maxSteps);
    const toolCallsMade: ToolCallRecord[] = [];
    let draftText = '';

    for (let step = 0; step < maxSteps; step += 1) {
      const result = streamText({
        model,
        system,
        messages,
        tools: aiTools,
        abortSignal: ctx.abortSignal,
      });

      for await (const part of result.fullStream) {
        if (part.type === 'text-delta') {
          draftText += part.text;
        }
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
        ctx.emit({
          type: 'tool-call',
          toolName: call.toolName,
          args: call.input,
          toolCallId: call.toolCallId,
        });

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
        toolCallsMade.push({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          args: call.input,
          result: toolResult,
          success: true,
          timestamp: Date.now(),
        });
        out.control ??= classifyControl(toolResult);

        ctx.emit({
          type: 'tool-result',
          toolName: call.toolName,
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

    const postTurn = await applyPostTurnPolicies(ctx, draftText, toolCallsMade);
    const finalText = postTurn.text;
    out.text = finalText;

    if (finalText) {
      ctx.emit({ type: 'text-delta', text: finalText });
    }

    ctx.emit({ type: 'turn-end' });
    return out;
  }

  async runStructured(node: DecideNode, ctx: RunContext): Promise<unknown> {
    const system = resolveInstructions(node.instructions, ctx.runState.state);
    const schema = node.schema as z.ZodType;
    const { object } = await generateObject({
      model: ctx.model,
      schema,
      system,
      messages: ctx.runState.messages,
      abortSignal: ctx.abortSignal,
    });
    return object;
  }

  async awaitUser(ctx: RunContext): Promise<UserSignal> {
    const input = consumePendingUserInput(ctx.session);
    return { type: 'message', input };
  }

  private resolveTools(resolved: ResolvedNode): ToolSet | undefined {
    const merged: Record<string, AnyTool> = { ...this.toolDefs, ...(resolved.localTools ?? {}) };
    const aiTools: ToolSet = { ...resolved.tools };
    for (const [name, tool] of Object.entries(merged)) {
      if (tool && !aiTools[name]) {
        const built = buildToolSet({ [name]: tool });
        Object.assign(aiTools, built);
      }
    }
    if (Object.keys(aiTools).length === 0 && Object.keys(merged).length === 0) {
      return undefined;
    }
    if (Object.keys(aiTools).length === 0) {
      return buildToolSet(merged);
    }
    return aiTools;
  }
}

export { buildNodePrompt };
