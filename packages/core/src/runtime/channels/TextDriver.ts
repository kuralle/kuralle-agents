import type { TurnResult, TurnUsageSnapshot, UserSignal, ResolvedNode } from '../../types/channel.js';
import type { RunContext } from '../../types/run-context.js';
import type { ChannelDriver } from '../../types/channel.js';
import type { ToolCallRecord } from '../../types/session.js';
import { streamText, type LanguageModelUsage, type ModelMessage, type ToolSet } from 'ai';
import type { ReplyNode, DecideNode } from '../../types/flow.js';
import { buildNodePrompt, resolveInstructions, composeSystem, systemMessagesText } from '../../flow/nodeBuilders.js';
import { systemNoteBlocks } from '../systemNotes.js';
import { buildToolSet } from '../../tools/effect/index.js';
import type { Tool, AnyTool } from '../../types/effectTool.js';
import { dispatchModelToolCalls, toolResultMessage } from './executeModelTool.js';
import { consumeAllPendingUserInput } from './inputBuffer.js';
import { runSilentExtraction } from './extractionTurn.js';
import { applyPreTurnPolicies, applyPostTurnPolicies } from '../policies/agentTurn.js';
import { resolveMaxSteps } from '../policies/limits.js';
import { speakWithHostControl } from './streaming/hostControlSpeak.js';
import type { TokenSource } from './streaming/speakGated.js';
import { resolveStreamMode } from './streaming/mode.js';
import { resolveNodeGatherScope, runGatherPhase } from '../grounding/index.js';
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
      ctx.emit({
        channel: 'internal',
        type: 'safety-blocked',
        payload: {
          moderator: preTurn.blockedBy ?? 'input-guardrails',
          rationale: preTurn.blockedReason ?? 'input blocked',
          userFacingMessage: blocked,
        },
      });
      const id = crypto.randomUUID();
      ctx.emit({ channel: 'client', type: 'text-start', payload: { id } });
      ctx.emit({ channel: 'client', type: 'text-delta', payload: { id, delta: blocked } });
      ctx.emit({ channel: 'client', type: 'text-end', payload: { id } });
      ctx.emit({ channel: 'internal', type: 'turn-end', payload: {} });
      return { text: blocked, toolResults: [] };
    }

    const scope = resolveNodeGatherScope(replyNode, ctx.runState.state, ctx.runState.messages);
    const gather = await runGatherPhase(ctx, scope);
    const out: TurnResult = { text: '', toolResults: [] };
    const toolMessages: ModelMessage[] = [];
    const model = replyNode.model ?? ctx.model;
    const nodeSystem = node.prompt || buildNodePrompt(replyNode, ctx.runState.state);
    const stableSystem = composeSystem(
      ctx.baseInstructions,
      nodeSystem,
      ctx.runState.state,
      ctx.skillPrompt,
      ctx.workingMemoryPrompt,
    );
    const volatileSystemBlocks = [
      gather.retrievalBlock,
      gather.memoryBlock,
      ...systemNoteBlocks(ctx.runState),
    ];
    const messages: ModelMessage[] = [...ctx.runState.messages];
    const aiTools = this.resolveTools(node, ctx);
    const maxSteps = resolveMaxSteps(ctx.limits, this.maxSteps);
    const toolCallsMade: ToolCallRecord[] = [];
    const mode = resolveStreamMode(ctx, node);
    const turnId = crypto.randomUUID();
    let turnUsage: TurnUsageSnapshot | undefined;

    const source: TokenSource = {
      async *[Symbol.asyncIterator]() {
        for (let step = 0; step < maxSteps; step += 1) {
          const cached = applyPromptCache({
            model,
            sessionId: ctx.session.id,
            messages,
            tools: aiTools,
            stableSystem,
            volatileSystemBlocks,
          });
          const result = streamText({
            model,
            ...(cached.system ? { system: cached.system } : {}),
            messages: cached.messages,
            tools: cached.tools ?? aiTools,
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
              ctx.emit({ channel: 'client', type: 'error', payload: { error: message } });
              throw err instanceof Error ? err : new Error(message);
            }
          }

          const finishReason = await result.finishReason;
          const response = await result.response;
          if (result.totalUsage) {
            const stepUsage = await result.totalUsage;
            if (stepUsage) {
              turnUsage = addTurnUsage(turnUsage, stepUsage);
            }
          }

          if (finishReason !== 'tool-calls') {
            messages.push(...response.messages);
            break;
          }

          messages.push(...response.messages);
          toolMessages.push(...response.messages);

          const toolCalls = await result.toolCalls;
          const mergedTools = {
            ...ctx.globalTools,
            ...(ctx.workingMemoryTools ?? {}),
            ...node.localTools,
          };
          await dispatchModelToolCalls(ctx, toolCalls, mergedTools, ({ call, outcome }) => {
            const { result: toolResult, control, failed } = outcome;
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

            const resultMessage = toolResultMessage(call, toolResult);
            messages.push(resultMessage);
            toolMessages.push(resultMessage);
          });
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
    if (toolMessages.length > 0) {
      out.toolMessages = toolMessages;
    }
    if (turnUsage && turnUsage.totalTokens > 0) {
      out.usage = turnUsage;
    }

    ctx.emit({ channel: 'internal', type: 'turn-end', payload: {} });
    return out;
  }

  // Non-speaking field extraction for collect nodes (shared helper so text and
  // voice are identical). The model's prose is discarded; the user-facing
  // question is emitted deterministically by the flow engine (CollectNode.ask).
  runExtraction(node: ResolvedNode, ctx: RunContext): Promise<TurnResult> {
    return runSilentExtraction(node, ctx, ctx.controlModel, resolveMaxSteps(ctx.limits, this.maxSteps));
  }

  async runStructured(node: DecideNode, ctx: RunContext): Promise<unknown> {
    const system = systemMessagesText(
      composeSystem(
        ctx.baseInstructions,
        resolveInstructions(node.instructions, ctx.runState.state),
        ctx.runState.state,
        ctx.skillPrompt,
        ctx.workingMemoryPrompt,
      ),
    );
    return resolveStructuredDecide(node, ctx, system);
  }

  async awaitUser(ctx: RunContext): Promise<UserSignal> {
    const input = consumeAllPendingUserInput(ctx.session) ?? '';
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

export { buildNodePrompt };
