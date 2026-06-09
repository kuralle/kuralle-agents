import type { TurnResult, UserSignal, ResolvedNode } from '../../types/channel.js';
import type { RunContext } from '../../types/run-context.js';
import type { ChannelDriver } from '../../types/channel.js';
import type { ToolCallRecord } from '../../types/session.js';
import { streamText, type ModelMessage, type ToolSet } from 'ai';
import type { ReplyNode, DecideNode } from '../../types/flow.js';
import { buildNodePrompt, resolveInstructions, composeSystem } from '../../flow/nodeBuilders.js';
import { buildToolSet } from '../../tools/effect/index.js';
import type { Tool, AnyTool } from '../../types/effectTool.js';
import { executeModelToolCall, toolResultMessage } from './executeModelTool.js';
import { consumePendingUserInput } from './inputBuffer.js';
import { runSilentExtraction } from './extractionTurn.js';
import { applyPreTurnPolicies, applyPostTurnPolicies } from '../policies/agentTurn.js';
import { resolveMaxSteps } from '../policies/limits.js';
import { speakWithHostControl } from './streaming/hostControlSpeak.js';
import type { TokenSource } from './streaming/speakGated.js';
import { resolveStreamMode } from './streaming/mode.js';
import { appendGatherBlocks, resolveNodeGatherScope, runGatherPhase } from '../grounding/index.js';
import { applyPromptCache } from '../promptCache.js';
import { isFlowTransitionControlTool } from '../../flow/flowControlTools.js';
import { resolveStructuredDecide } from '../../flow/choiceMatch.js';

export interface TextDriverConfig {
  toolDefs?: Record<string, AnyTool>;
  maxSteps?: number;
}

export class TextDriver implements ChannelDriver {
  readonly outputCapability = 'kuralle-controlled-text' as const;
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
      const id = crypto.randomUUID();
      ctx.emit({ type: 'text-start', id });
      ctx.emit({ type: 'text-delta', id, delta: blocked });
      ctx.emit({ type: 'text-end', id });
      ctx.emit({ type: 'turn-end' });
      return { text: blocked, toolResults: [] };
    }

    const scope = resolveNodeGatherScope(replyNode, ctx.runState.state, ctx.runState.messages);
    const gather = await runGatherPhase(ctx, scope);
    const out: TurnResult = { text: '', toolResults: [] };
    const model = replyNode.model ?? ctx.model;
    const nodeSystem = node.prompt || buildNodePrompt(replyNode, ctx.runState.state);
    const baseSystem = composeSystem(
      ctx.baseInstructions,
      nodeSystem,
      ctx.runState.state,
      ctx.skillPrompt,
      ctx.workingMemoryPrompt,
    );
    const system = appendGatherBlocks(baseSystem, [gather.retrievalBlock, gather.memoryBlock]);
    const messages: ModelMessage[] = [...ctx.runState.messages];
    const aiTools = this.resolveTools(node, ctx);
    const maxSteps = resolveMaxSteps(ctx.limits, this.maxSteps);
    const toolCallsMade: ToolCallRecord[] = [];
    const mode = resolveStreamMode(ctx, node);
    const turnId = crypto.randomUUID();

    const source: TokenSource = {
      async *[Symbol.asyncIterator]() {
        for (let step = 0; step < maxSteps; step += 1) {
          const cached = applyPromptCache(model, ctx.session.id, messages);
          const result = streamText({
            model,
            system,
            messages: cached.messages,
            tools: aiTools,
            abortSignal: ctx.abortSignal,
            ...(cached.providerOptions ? { providerOptions: cached.providerOptions } : {}),
          });

          for await (const part of result.fullStream) {
            if (part.type === 'text-delta') {
              yield { delta: part.text };
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
              {
                ...ctx.globalTools,
                ...(ctx.workingMemoryTools ?? {}),
                ...node.localTools,
              },
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
      },
    };

    const runGate = async (text: string, _final: boolean) => {
      const r = await applyPostTurnPolicies(ctx, text, toolCallsMade, gather.citations ?? []);
      return {
        blocked: !r.proceed,
        text: r.proceed ? r.text : (r.blockedMessage ?? r.text),
        reason: r.control?.reason,
        control: r.control,
        confidence: r.confidence,
      };
    };

    const speakFn = node.hostControl
      ? speakWithHostControl({
          ctx,
          mode,
          turnId,
          source,
          runGate,
          dispatchMode: node.hostControl.dispatchMode,
          getToolControl: () => out.control,
        })
      : (await import('./streaming/speakGated.js')).speakGated({
          ctx,
          mode,
          turnId,
          source,
          runGate,
        });

    const spoken = await speakFn;

    out.text = spoken.text;
    out.control = spoken.control ?? out.control;
    out.confidence = spoken.confidence;

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
    const system = composeSystem(
      ctx.baseInstructions,
      resolveInstructions(node.instructions, ctx.runState.state),
      ctx.runState.state,
      ctx.skillPrompt,
      ctx.workingMemoryPrompt,
    );
    return resolveStructuredDecide(node, ctx, system);
  }

  async awaitUser(ctx: RunContext): Promise<UserSignal> {
    const input = consumePendingUserInput(ctx.session);
    return { type: 'message', input };
  }

  private resolveTools(resolved: ResolvedNode, ctx: RunContext): ToolSet | undefined {
    const siloFlowControl = ctx.outOfBandControl && !resolved.freeConversation;
    const merged: Record<string, AnyTool> = {
      ...this.toolDefs,
      ...(ctx.globalTools ?? {}),
      ...(ctx.workingMemoryTools ?? {}),
      ...(resolved.localTools ?? {}),
    };
    const aiTools: ToolSet = { ...resolved.tools };
    for (const [name, tool] of Object.entries(merged)) {
      if (siloFlowControl && isFlowTransitionControlTool(name)) {
        continue;
      }
      if (tool && !aiTools[name]) {
        const built = buildToolSet({ [name]: tool });
        Object.assign(aiTools, built);
      }
    }
    if (siloFlowControl) {
      for (const name of Object.keys(aiTools)) {
        if (isFlowTransitionControlTool(name)) {
          delete aiTools[name];
        }
      }
    }
    if (Object.keys(aiTools).length === 0 && Object.keys(merged).length === 0) {
      return undefined;
    }
    if (Object.keys(aiTools).length === 0) {
      const filteredMerged = siloFlowControl
        ? Object.fromEntries(
            Object.entries(merged).filter(([name]) => !isFlowTransitionControlTool(name)),
          )
        : merged;
      if (Object.keys(filteredMerged).length === 0) {
        return undefined;
      }
      return buildToolSet(filteredMerged);
    }
    return aiTools;
  }
}

export { buildNodePrompt };
