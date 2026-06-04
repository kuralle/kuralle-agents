import type { TurnResult, UserSignal, ResolvedNode } from '../../types/channel.js';
import type { RunContext } from '../../types/run-context.js';
import type { ChannelDriver } from '../../types/channel.js';
import type { ToolCallRecord } from '../../types/session.js';
import { streamText, generateObject, type ModelMessage, type ToolSet } from 'ai';
import type { ReplyNode, DecideNode } from '../../types/flow.js';
import { buildNodePrompt, resolveInstructions, composeSystem } from '../../flow/nodeBuilders.js';
import { buildToolSet } from '../../tools/effect/index.js';
import type { Tool, AnyTool } from '../../types/effectTool.js';
import { executeModelToolCall, toolResultMessage } from './executeModelTool.js';
import { consumePendingUserInput } from './inputBuffer.js';
import { runSilentExtraction } from './extractionTurn.js';
import { applyPreTurnPolicies, applyPostTurnPolicies } from '../policies/agentTurn.js';
import { resolveMaxSteps } from '../policies/limits.js';
import { appendGatherBlocks, resolveNodeGatherScope, runGatherPhase } from '../grounding/index.js';
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

    const scope = resolveNodeGatherScope(replyNode, ctx.runState.state, ctx.runState.messages);
    const gather = await runGatherPhase(ctx, scope);
    const out: TurnResult = { text: '', toolResults: [] };
    const model = replyNode.model ?? ctx.model;
    const nodeSystem = node.prompt || buildNodePrompt(replyNode, ctx.runState.state);
    const baseSystem = composeSystem(ctx.baseInstructions, nodeSystem, ctx.runState.state);
    const system = appendGatherBlocks(baseSystem, [gather.retrievalBlock, gather.memoryBlock]);
    const messages: ModelMessage[] = [...ctx.runState.messages];
    const aiTools = this.resolveTools(node, ctx.globalTools);
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

        const { result: toolResult, control, failed } = await executeModelToolCall(
          ctx,
          { toolName: call.toolName, input: call.input, toolCallId: call.toolCallId },
          node.localTools,
        );
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
          success: !failed,
          timestamp: Date.now(),
        });
        out.control ??= control;

        ctx.emit({
          type: 'tool-result',
          toolName: call.toolName,
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

  // Non-speaking field extraction for collect nodes (shared helper so text and
  // voice are identical). The model's prose is discarded; the user-facing
  // question is emitted deterministically by the flow engine (CollectNode.ask).
  runExtraction(node: ResolvedNode, ctx: RunContext): Promise<TurnResult> {
    return runSilentExtraction(node, ctx, ctx.controlModel, resolveMaxSteps(ctx.limits, this.maxSteps));
  }

  async runStructured(node: DecideNode, ctx: RunContext): Promise<unknown> {
    const base = composeSystem(
      ctx.baseInstructions,
      resolveInstructions(node.instructions, ctx.runState.state),
      ctx.runState.state,
    );
    const schema = node.schema as z.ZodType;
    // When the node offers choices (e.g. via withChoices), constrain the model
    // to return exactly one option id. Otherwise an unconstrained string schema
    // lets the model reply with free-form prose that `decide()` can't match,
    // stalling the flow at every interactive node.
    const system = node.choices?.length
      ? `${base}\n\nYou MUST pick exactly ONE option by its id. Valid ids: ${node.choices
          .map((c) => c.id)
          .join(', ')}. Respond with only the chosen id, nothing else.`
      : base;
    const { object } = await generateObject({
      model: ctx.controlModel,
      schema,
      system,
      messages: ctx.runState.messages,
      temperature: 0,
      abortSignal: ctx.abortSignal,
    });
    return object;
  }

  async awaitUser(ctx: RunContext): Promise<UserSignal> {
    const input = consumePendingUserInput(ctx.session);
    return { type: 'message', input };
  }

  private resolveTools(resolved: ResolvedNode, globalTools?: Record<string, AnyTool>): ToolSet | undefined {
    const merged: Record<string, AnyTool> = { ...this.toolDefs, ...(globalTools ?? {}), ...(resolved.localTools ?? {}) };
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
