import type { TurnResult, UserSignal, ResolvedNode } from '../../types/channel.js';
import type { RunContext } from '../../types/run-context.js';
import type { ChannelDriver } from '../../types/channel.js';
import type { ToolCallRecord } from '../../types/session.js';
import { generateObject } from 'ai';
import { runSilentExtraction } from './extractionTurn.js';
import type { ReplyNode, DecideNode } from '../../types/flow.js';
import { buildNodePrompt, resolveInstructions } from '../../flow/nodeBuilders.js';
import type { Tool, AnyTool } from '../../types/effectTool.js';
import { classifyControl } from '../../flow/classifyControl.js';
import { applyPreTurnPolicies, applyPostTurnPolicies } from '../policies/agentTurn.js';
import { resolveMaxSteps } from '../policies/limits.js';
import { appendGatherBlocks, runGatherPhase } from '../grounding/index.js';
import type { RealtimeSessionConfig, RealtimeToolResponse } from '../../realtime/RealtimeAudioClient.js';
import type { RealtimeAudioClient } from '../../realtime/RealtimeAudioClient.js';
import { resolveVoiceGeminiTools } from './voiceTools.js';
import { z } from 'zod';

export interface VoiceDriverConfig {
  client: RealtimeAudioClient;
  toolDefs?: Record<string, AnyTool>;
  maxSteps?: number;
}

type CollectOutcome = 'complete' | 'interrupted';

export class VoiceDriver implements ChannelDriver {
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
      ctx.emit({ type: 'text-delta', text: blocked });
      ctx.emit({ type: 'turn-end' });
      return { text: blocked, toolResults: [] };
    }

    const gather = await runGatherPhase(ctx);
    const out: TurnResult = { text: '', toolResults: [] };
    const baseSystem = node.prompt || buildNodePrompt(replyNode, ctx.runState.state);
    const system = appendGatherBlocks(baseSystem, [gather.retrievalBlock, gather.memoryBlock]);
    const geminiTools = resolveVoiceGeminiTools(node, this.toolDefs);
    const toolCallsMade: ToolCallRecord[] = [];
    const maxSteps = resolveMaxSteps(ctx.limits, this.maxSteps);
    let draftText = '';
    this.heardCharCount = 0;

    await this.reconfigure({ systemInstruction: system, tools: geminiTools });

    for (let step = 0; step < maxSteps; step += 1) {
      const { outcome, assistantText } = await this.collectProviderTurn(
        ctx,
        out,
        step === 0,
        toolCallsMade,
        node.localTools,
      );
      draftText += assistantText;

      if (outcome === 'interrupted') {
        out.interrupted = true;
        out.truncateAt = this.heardCharCount;
        out.text = truncateToHeard(draftText, this.heardCharCount);
        ctx.emit({ type: 'text-delta', text: out.text });
        ctx.emit({ type: 'turn-end' });
        return out;
      }

      if (out.toolResults.length === 0 || outcome === 'complete') {
        break;
      }
    }

    const postTurn = await applyPostTurnPolicies(ctx, draftText, toolCallsMade);
    out.text = postTurn.text;

    if (out.text) {
      ctx.emit({ type: 'text-delta', text: out.text });
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

  // Non-speaking collect extraction: uses the shared text-model extraction path
  // rather than the realtime audio provider, so the agent never SPEAKS during
  // field collection (which is where ungrounded narration leaked). Identical
  // behavior to TextDriver — voice and text emit the same structural events; the
  // user-facing question is the deterministic CollectNode.ask, synthesized after.
  runExtraction(node: ResolvedNode, ctx: RunContext): Promise<TurnResult> {
    return runSilentExtraction(node, ctx, ctx.model, resolveMaxSteps(ctx.limits, this.maxSteps));
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
    localTools?: Record<string, AnyTool>,
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
        reject(error);
      };

      const onTranscript = (text: string, role: 'user' | 'assistant'): void => {
        if (role === 'assistant') {
          assistantText += text;
          this.heardCharCount += text.length;
        }
        if (role === 'user' && sawInterrupt) {
          this.pendingBargeInInput = text;
        }
      };

      const onToolCall = (id: string, name: string, args: unknown): void => {
        void (async () => {
          try {
            ctx.emit({ type: 'tool-call', toolName: name, args, toolCallId: id });

            const localTool = localTools?.[name];
            const toolResult = await ctx.tool(name, args, {
              toolCallId: id,
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

            out.toolResults.push({ name, args, result: toolResult, toolCallId: id });
            toolCallsMade.push({
              toolCallId: id,
              toolName: name,
              args,
              result: toolResult,
              success: true,
              timestamp: Date.now(),
            });
            out.control ??= classifyControl(toolResult);

            ctx.emit({ type: 'tool-result', toolName: name, result: toolResult, toolCallId: id });

            this.client.sendToolResponse([{ id, name, output: toolResult }]);
          } catch (error) {
            fail(error);
          }
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
