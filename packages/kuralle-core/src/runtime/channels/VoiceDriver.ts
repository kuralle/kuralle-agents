import type { TurnResult, UserSignal, ResolvedNode } from '../../types/channel.js';
import type { RunContext } from '../../types/run-context.js';
import type { ChannelDriver } from '../../types/channel.js';
import type { ToolCallRecord } from '../../types/session.js';
import { runSilentExtraction } from './extractionTurn.js';
import { resolveStructuredDecide } from '../../flow/choiceMatch.js';
import type { ReplyNode, DecideNode } from '../../types/flow.js';
import { buildNodePrompt, resolveInstructions, composeSystem } from '../../flow/nodeBuilders.js';
import type { Tool, AnyTool } from '../../types/effectTool.js';
import { executeModelToolCall } from './executeModelTool.js';
import { applyPreTurnPolicies, applyPostTurnPolicies } from '../policies/agentTurn.js';
import { resolveMaxSteps } from '../policies/limits.js';
import { speakGated } from './streaming/speakGated.js';
import { resolveStreamMode } from './streaming/mode.js';
import {
  createDeferredTokenSource,
  type DeferredTokenSource,
} from './streaming/deferredTokenSource.js';
import { appendGatherBlocks, resolveNodeGatherScope, runGatherPhase } from '../grounding/index.js';
import type { RealtimeSessionConfig, RealtimeToolResponse } from '../../realtime/RealtimeAudioClient.js';
import type { RealtimeAudioClient } from '../../realtime/RealtimeAudioClient.js';
import { resolveVoiceGeminiTools } from './voiceTools.js';

interface NativeRealtimePostHocGate {
  safeText: string;
  rationale: string;
  moderator: string;
  escalated: boolean;
}

function emitNativeRealtimePostHocGate(
  ctx: RunContext,
  client: RealtimeAudioClient,
  gate: NativeRealtimePostHocGate,
): void {
  if (gate.escalated) {
    ctx.emit({
      type: 'safety-blocked',
      moderator: gate.moderator,
      rationale: gate.rationale,
      userFacingMessage: gate.safeText,
    });
  } else {
    ctx.emit({
      type: 'pipeline-validation-block',
      rationale: gate.rationale,
      userFacingMessage: gate.safeText,
    });
    ctx.emit({
      type: 'safety-blocked',
      moderator: gate.moderator,
      rationale: gate.rationale,
      userFacingMessage: gate.safeText,
    });
  }

  client.requestResponse?.(gate.safeText);
}
export interface VoiceDriverConfig {
  client: RealtimeAudioClient;
  toolDefs?: Record<string, AnyTool>;
  maxSteps?: number;
}

type CollectOutcome = 'complete' | 'interrupted';

export class VoiceDriver implements ChannelDriver {
  readonly outputCapability = 'native-realtime' as const;
  private readonly client: RealtimeAudioClient;
  private readonly toolDefs: Record<string, AnyTool>;
  private readonly maxSteps: number;
  private heardCharCount = 0;
  private pendingBargeInInput: string | null = null;

  constructor(config: VoiceDriverConfig) {
    this.client = config.client;
    this.toolDefs = config.toolDefs ?? {};
    this.maxSteps = config.maxSteps ?? 5;
  }

  async runAgentTurn(node: ResolvedNode, ctx: RunContext): Promise<TurnResult> {
    const replyNode = node.node as ReplyNode;
    if (replyNode.kind !== 'reply') {
      throw new Error(`VoiceDriver.runAgentTurn expects a reply node, got ${replyNode.kind}`);
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
    const nodeSystem = node.prompt || buildNodePrompt(replyNode, ctx.runState.state);
    const baseSystem = composeSystem(
      ctx.baseInstructions,
      nodeSystem,
      ctx.runState.state,
      ctx.skillPrompt,
      ctx.workingMemoryPrompt,
    );
    const system = appendGatherBlocks(baseSystem, [gather.retrievalBlock, gather.memoryBlock]);
    const geminiTools = resolveVoiceGeminiTools(
      node,
      { ...this.toolDefs, ...(ctx.globalTools ?? {}), ...(ctx.workingMemoryTools ?? {}) },
      { siloFlowControl: ctx.outOfBandControl && !node.freeConversation },
    );
    const toolCallsMade: ToolCallRecord[] = [];
    const maxSteps = resolveMaxSteps(ctx.limits, this.maxSteps);
    const mode = resolveStreamMode(ctx, node);
    const turnId = crypto.randomUUID();
    const transcript = createDeferredTokenSource();
    let draftText = '';
    this.heardCharCount = 0;
    let postHocGate: NativeRealtimePostHocGate | null = null;

    const speakPromise = speakGated({
      ctx,
      mode,
      turnId,
      source: transcript.source,
      runGate: async (text, _final) => {
        const r = await applyPostTurnPolicies(ctx, text, toolCallsMade, gather.citations ?? []);
        if (!r.proceed) {
          const safeText = r.blockedMessage ?? r.text;
          postHocGate = {
            safeText,
            rationale: r.control?.reason ?? 'blocked',
            moderator: 'post-turn-gate',
            escalated: r.control?.type === 'escalate',
          };
        }
        return {
          blocked: !r.proceed,
          text: r.proceed ? r.text : (r.blockedMessage ?? r.text),
          reason: r.control?.reason,
          control: r.control,
          confidence: r.confidence,
        };
      },
    });

    await this.reconfigure({ systemInstruction: system, tools: geminiTools });

    for (let step = 0; step < maxSteps; step += 1) {
      const { outcome, assistantText } = await this.collectProviderTurn(
        ctx,
        out,
        step === 0,
        toolCallsMade,
        node.localTools,
        transcript,
      );
      draftText += assistantText;

      if (outcome === 'interrupted') {
        transcript.close('interrupted');
        try {
          await speakPromise;
        } catch {
          /* speakGated cancels in-flight stream on interrupt */
        }
        out.interrupted = true;
        out.truncateAt = this.heardCharCount;
        out.text = truncateToHeard(draftText, this.heardCharCount);
        const id = crypto.randomUUID();
        ctx.emit({ type: 'text-start', id });
        ctx.emit({ type: 'text-delta', id, delta: out.text });
        ctx.emit({ type: 'text-end', id });
        ctx.emit({ type: 'turn-end' });
        return out;
      }

      if (out.toolResults.length === 0 || outcome === 'complete') {
        break;
      }
    }

    transcript.close('complete');
    const spoken = await speakPromise;
    out.text = spoken.text;
    // Preserve host-control raised during provider tool execution (enter_flow /
    // transfer_to_agent); the post-hoc gate must not clobber it (else native
    // realtime silently drops valid routing). Same fix as TextDriver.
    out.control = spoken.control ?? out.control;
    out.confidence = spoken.confidence;

    if (postHocGate) {
      // Advisory post-hoc gate: provider audio may already have played; correction does not un-speak it.
      emitNativeRealtimePostHocGate(ctx, this.client, postHocGate);
      out.gateScope = 'advisory';
    }

    ctx.emit({ type: 'turn-end' });
    return out;
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

  // Non-speaking collect extraction: uses the shared text-model extraction path
  // rather than the realtime audio provider, so the agent never SPEAKS during
  // field collection (which is where ungrounded narration leaked). Identical
  // behavior to TextDriver — voice and text emit the same structural events; the
  // user-facing question is the deterministic CollectNode.ask, synthesized after.
  runExtraction(node: ResolvedNode, ctx: RunContext): Promise<TurnResult> {
    return runSilentExtraction(node, ctx, ctx.controlModel, resolveMaxSteps(ctx.limits, this.maxSteps));
  }

  async awaitUser(ctx: RunContext): Promise<UserSignal> {
    if (this.pendingBargeInInput != null) {
      const input = this.pendingBargeInInput;
      this.pendingBargeInInput = null;
      return { type: 'message', input };
    }

    const input = await this.waitForUserTurn(ctx);
    return { type: 'message', input };
  }

  async reconfigure(config: Partial<RealtimeSessionConfig>): Promise<void> {
    await this.client.updateConfig(config);
  }

  getHeardCharCount(): number {
    return this.heardCharCount;
  }

  private async collectProviderTurn(
    ctx: RunContext,
    out: TurnResult,
    triggerResponse: boolean,
    toolCallsMade: ToolCallRecord[],
    localTools: Record<string, AnyTool> | undefined,
    transcript: DeferredTokenSource,
  ): Promise<{ outcome: CollectOutcome; assistantText: string }> {
    return new Promise((resolve, reject) => {
      let assistantText = '';
      let settled = false;
      let sawInterrupt = false;

      const finish = (outcome: CollectOutcome): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ outcome, assistantText });
      };

      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        transcript.close('error');
        reject(error);
      };

      const onTranscript = (text: string, role: 'user' | 'assistant'): void => {
        if (role === 'assistant') {
          assistantText += text;
          this.heardCharCount += text.length;
          transcript.push(text);
        }
        if (role === 'user' && sawInterrupt) {
          this.pendingBargeInInput = text;
        }
      };

      const onToolCall = (id: string, name: string, args: unknown): void => {
        void (async () => {
          ctx.emit({ type: 'tool-call', toolName: name, args, toolCallId: id });

          const { result: toolResult, control, failed } = await executeModelToolCall(
            ctx,
            { toolName: name, input: args, toolCallId: id },
            {
              ...ctx.globalTools,
              ...(ctx.workingMemoryTools ?? {}),
              ...localTools,
            },
          );

          out.toolResults.push({ name, args, result: toolResult, toolCallId: id });
          toolCallsMade.push({
            toolCallId: id,
            toolName: name,
            args,
            result: toolResult,
            success: !failed,
            timestamp: Date.now(),
          });
          out.control ??= control;

          ctx.emit({ type: 'tool-result', toolName: name, result: toolResult, toolCallId: id });

          this.client.sendToolResponse([{ id, name, output: toolResult }]);
        })();
      };

      const onTurnComplete = (): void => {
        finish(sawInterrupt ? 'interrupted' : 'complete');
      };

      const onInterrupted = (): void => {
        sawInterrupt = true;
        out.truncateAt = this.heardCharCount;
      };

      const onError = (error: string): void => {
        ctx.emit({ type: 'error', error });
        fail(new Error(error));
      };

      const onAbort = (): void => {
        sawInterrupt = true;
        out.truncateAt = this.heardCharCount;
        finish('interrupted');
      };

      const cleanup = (): void => {
        this.client.off('transcript', onTranscript);
        this.client.off('tool-call', onToolCall);
        this.client.off('turn-complete', onTurnComplete);
        this.client.off('interrupted', onInterrupted);
        this.client.off('error', onError);
        ctx.bargeIn?.removeEventListener('abort', onAbort);
        ctx.abortSignal?.removeEventListener('abort', onAbort);
      };

      this.client.on('transcript', onTranscript);
      this.client.on('tool-call', onToolCall);
      this.client.on('turn-complete', onTurnComplete);
      this.client.on('interrupted', onInterrupted);
      this.client.on('error', onError);
      ctx.bargeIn?.addEventListener('abort', onAbort, { once: true });
      ctx.abortSignal?.addEventListener('abort', onAbort, { once: true });

      if (triggerResponse && this.client.requestResponse) {
        this.client.requestResponse();
      }
    });
  }

  private waitForUserTurn(_ctx: RunContext): Promise<string> {
    return new Promise((resolve, reject) => {
      let userText = '';
      let settled = false;

      const finish = (text: string): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(text);
      };

      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      const onTranscript = (text: string, role: 'user' | 'assistant'): void => {
        if (role === 'user') {
          userText += text;
        }
      };

      const onTurnComplete = (): void => {
        finish(userText);
      };

      const onError = (error: string): void => {
        fail(new Error(error));
      };

      const cleanup = (): void => {
        this.client.off('transcript', onTranscript);
        this.client.off('turn-complete', onTurnComplete);
        this.client.off('error', onError);
      };

      this.client.on('transcript', onTranscript);
      this.client.on('turn-complete', onTurnComplete);
      this.client.on('error', onError);
    });
  }
}

function truncateToHeard(text: string, heardChars: number): string {
  if (heardChars <= 0) {
    return '';
  }
  if (heardChars >= text.length) {
    return text;
  }
  const truncated = text.slice(0, heardChars);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > heardChars * 0.6) {
    return truncated.slice(0, lastSpace);
  }
  return truncated;
}

export { buildNodePrompt };
