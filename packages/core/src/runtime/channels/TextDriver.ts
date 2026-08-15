import type { TurnResult, UserSignal, ResolvedNode } from '../../types/channel.js';
import type { RunContext } from '../../types/run-context.js';
import type { ChannelDriver } from '../../types/channel.js';
import type { ModelMessage, ToolSet } from 'ai';
import type { ReplyNode, DecideNode } from '../../types/flow.js';
import { buildNodePrompt, resolveInstructions, composeSystem, systemMessagesText } from '../../flow/nodeBuilders.js';
import { systemNoteBlocks } from '../systemNotes.js';
import type { AnyTool } from '../../types/effectTool.js';
import { consumeAllPendingUserInput } from './inputBuffer.js';
import { runSilentExtraction } from './extractionTurn.js';
import { applyPreTurnPolicies, applyPostTurnPolicies } from '../policies/agentTurn.js';
import { resetSkillActivationsOnTurnStart } from '../../skills/skillActivation.js';
import { resolveMaxSteps } from '../policies/limits.js';
import { speakWithHostControl } from './streaming/hostControlSpeak.js';
import { resolveStreamMode } from './streaming/mode.js';
import { resolveNodeGatherScope, runGatherPhase } from '../grounding/index.js';
import { applyPromptCache } from '../promptCache.js';
import { resolveStructuredDecide } from '../../flow/choiceMatch.js';
import { resolveNodeTools } from './resolveNodeTools.js';
import { currentFlowState } from '../../flow/flowState.js';
import { createDeferredTokenSource } from './streaming/deferredTokenSource.js';
import { AiSdkModelTurnLoop } from './AiSdkModelTurnLoop.js';
import {
  applyModelTurnLoopState,
  createModelTurnLoopState,
  type ModelTurnLoop,
} from './ModelTurnLoop.js';

export interface TextDriverConfig {
  toolDefs?: Record<string, AnyTool>;
  maxSteps?: number;
  /** Replaces only the provider/tool iteration loop; Kuralle still owns turn composition. */
  modelLoop?: ModelTurnLoop;
}

export class TextDriver implements ChannelDriver {
  readonly outputCapability = 'kuralle-controlled-text' as const;
  private readonly toolDefs: Record<string, AnyTool>;
  private readonly maxSteps: number;
  private readonly modelLoop: ModelTurnLoop;

  constructor(config: TextDriverConfig = {}) {
    this.toolDefs = config.toolDefs ?? {};
    this.maxSteps = config.maxSteps ?? 5;
    this.modelLoop = config.modelLoop ?? new AiSdkModelTurnLoop();
  }

  async runAgentTurn(node: ResolvedNode, ctx: RunContext): Promise<TurnResult> {
    // Per node: each flow node re-plans with node-scoped instructions, so a skill activated
    // in a prior node must not silently constrain this one (see resetSkillActivationsOnTurnStart).
    resetSkillActivationsOnTurnStart(ctx);
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
      ctx.emit({ channel: 'internal', type: 'turn-end', payload: { rendered: 'model' } });
      return { text: blocked, toolResults: [] };
    }

    const state = currentFlowState(ctx.runState);
    const scope = resolveNodeGatherScope(replyNode, state, ctx.runState.messages);
    const gather = await runGatherPhase(ctx, scope);
    const out: TurnResult = { text: '', toolResults: [] };
    const model = replyNode.model ?? ctx.model;
    const nodeSystem = node.prompt || buildNodePrompt(replyNode, state);
    const stableSystem = composeSystem(
      ctx.baseInstructions,
      nodeSystem,
      state,
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
    const mode = resolveStreamMode(ctx, node);
    const turnId = crypto.randomUUID();
    const loopState = createModelTurnLoopState();
    const deferred = createDeferredTokenSource();
    const loopDone = this.modelLoop.run(
      {
        purpose: 'speaking',
        node,
        ctx,
        model,
        messages,
        system: stableSystem,
        volatileSystemBlocks,
        tools: aiTools,
        maxSteps,
      },
      loopState,
      (delta) => deferred.push(delta),
    ).then(
      () => deferred.close(),
      (error) => {
        deferred.fail(error);
        throw error;
      },
    );
    // The source observes the same rejection. Mark the promise handled now so
    // a synchronously failing loop cannot become an unhandled rejection before
    // the gated consumer reaches it.
    void loopDone.catch(() => undefined);
    const source = deferred.source;

    const runGate = async (text: string, _final: boolean) => {
      const r = await applyPostTurnPolicies(ctx, text, loopState.toolCallsMade, gather.citations ?? []);
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
          getToolControl: () => loopState.control,
        })
      : (await import('./streaming/speakGated.js')).speakGated({
          ctx,
          mode,
          turnId,
          source,
          runGate,
        });

    const spoken = await speakFn;
    await loopDone;

    out.text = spoken.text;
    applyModelTurnLoopState(out, loopState);
    out.control = spoken.control ?? out.control;
    out.confidence = spoken.confidence;

    ctx.emit({ channel: 'internal', type: 'turn-end', payload: { rendered: 'model' } });
    return out;
  }

  // Non-speaking field extraction for collect nodes (shared helper so text and
  // voice are identical). The model's prose is discarded; the user-facing
  // question is emitted deterministically by the flow engine (CollectNode.ask).
  runExtraction(node: ResolvedNode, ctx: RunContext): Promise<TurnResult> {
    return runSilentExtraction(
      node,
      ctx,
      ctx.controlModel,
      resolveMaxSteps(ctx.limits, this.maxSteps),
      this.agentToolDefs(ctx),
      this.modelLoop,
    );
  }

  async runStructured(node: DecideNode, ctx: RunContext): Promise<unknown> {
    const stableSystem = buildDecideSystem(node, ctx);
    // Decide nodes fire on every flow transition and used to bypass prompt caching
    // entirely — full price, every time, invisible in the per-turn rate because that
    // only samples the main channel.
    const cached = applyPromptCache({
      model: ctx.controlModel,
      sessionId: ctx.session.id,
      messages: ctx.runState.messages,
      stableSystem,
    });
    return resolveStructuredDecide(node, ctx, stableSystem, cached.providerOptions);
  }

  async awaitUser(ctx: RunContext): Promise<UserSignal> {
    const input = consumeAllPendingUserInput(ctx.session, ctx.runState) ?? '';
    return { type: 'message', input };
  }

  private agentToolDefs(ctx: RunContext): Record<string, AnyTool> {
    return ctx.agentTools ?? this.toolDefs;
  }

  private resolveTools(resolved: ResolvedNode, ctx: RunContext): ToolSet | undefined {
    return resolveNodeTools(resolved, ctx, this.agentToolDefs(ctx));
  }
}

export { addTurnUsage, languageModelId } from './turnUsage.js';

export { buildNodePrompt };

/** Compose the base layer for any custom driver's structured decide path. */
export function buildDecideSystem(node: DecideNode, ctx: RunContext) {
  const state = currentFlowState(ctx.runState);
  return composeSystem(
    ctx.baseInstructions,
    resolveInstructions(node.instructions, state),
    state,
    ctx.skillPrompt,
    ctx.workingMemoryPrompt,
  );
}
