import {
  runAgentLoopContinue,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentTool,
  type AgentToolResult,
} from '@earendil-works/pi-agent-core';
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  ToolCall,
  TSchema,
  Usage,
} from '@earendil-works/pi-ai';
import { asSchema, type JSONValue, type ModelMessage } from 'ai';
import {
  dispatchModelToolCalls,
  toolResultMessage,
  type ModelToolCall,
  type ModelTurnLoop,
  type ModelTurnLoopInput,
  type ModelTurnLoopState,
} from '@kuralle-agents/core/runtime';
import type { AnyTool } from '@kuralle-agents/core';
import { aiMessagesToPi, piAssistantToAi, piToolResultToAi } from './messages.js';
import type { PiDriverConfig } from './types.js';
import { resolvePiStreamFn } from './streamFn.js';

interface DeferredResult {
  resolve(value: { result: unknown; failed: boolean; terminate: boolean }): void;
  reject(error: unknown): void;
  promise: Promise<{ result: unknown; failed: boolean; terminate: boolean }>;
}

function deferredResult(): DeferredResult {
  let resolve!: DeferredResult['resolve'];
  let reject!: DeferredResult['reject'];
  const promise = new Promise<{ result: unknown; failed: boolean; terminate: boolean }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve, reject, promise };
}

function resultText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function piFailureResult(result: AgentToolResult<unknown>): { error: string } {
  const error = result.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  return { error: error || 'Tool call failed before execution.' };
}

function kuralleResultMessage(call: ModelToolCall, result: unknown, failed: boolean): ModelMessage {
  if (!failed) return toolResultMessage(call, result);
  return {
    role: 'tool',
    content: [{
      type: 'tool-result',
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: { type: 'error-json', value: result as JSONValue },
    }],
  };
}

class KuralleToolBatch {
  private calls: ModelToolCall[] = [];
  private registrations = new Map<string, DeferredResult>();
  private scheduled = false;
  private completed = false;
  private signal: unknown;
  private failures = new Map<string, boolean>();

  constructor(
    private readonly input: ModelTurnLoopInput,
    private readonly state: ModelTurnLoopState,
  ) {}

  setAssistant(message: AssistantMessage): void {
    const calls = message.content
      .filter((part): part is ToolCall => part.type === 'toolCall')
      .map((part) => ({ toolName: part.name, input: part.arguments, toolCallId: part.id }));
    const seen = new Set<string>();
    const duplicate = calls.find((call) => {
      if (seen.has(call.toolCallId)) return true;
      seen.add(call.toolCallId);
      return false;
    });
    if (duplicate) {
      throw new Error(
        `PiDriver received duplicate toolCallId "${duplicate.toolCallId}" in one assistant message`,
      );
    }
    const signature = calls.map((call) => call.toolCallId).join('\0');
    if (this.completed || signature !== this.calls.map((call) => call.toolCallId).join('\0')) {
      this.calls = calls;
      this.registrations = new Map();
      this.scheduled = false;
      this.completed = false;
      this.failures = new Map();
      this.signal = undefined;
    }
  }

  async execute(toolCallId: string): Promise<{ result: unknown; failed: boolean; terminate: boolean }> {
    if (!this.call(toolCallId)) {
      throw new Error(`PiDriver received tool execution for unknown toolCallId "${toolCallId}"`);
    }
    if (this.registrations.has(toolCallId)) {
      throw new Error(`PiDriver received duplicate tool execution for toolCallId "${toolCallId}"`);
    }
    const deferred = deferredResult();
    this.registrations.set(toolCallId, deferred);
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        void this.dispatch().catch((error) => {
          this.signal = error;
          for (const pending of this.registrations.values()) pending.reject(error);
        });
      });
    }
    return deferred.promise;
  }

  takeSignal(): unknown {
    return this.signal;
  }

  call(toolCallId: string): ModelToolCall | undefined {
    return this.calls.find((call) => call.toolCallId === toolCallId);
  }

  wasDispatched(toolCallId: string): boolean {
    return this.registrations.has(toolCallId);
  }

  failed(toolCallId: string): boolean | undefined {
    return this.failures.get(toolCallId);
  }

  private async dispatch(): Promise<void> {
    const activeCalls = this.calls.filter((call) => this.registrations.has(call.toolCallId));
    const outcomes = new Map<string, { result: unknown; failed: boolean }>();
    const mergedTools: Record<string, AnyTool> = {
      ...this.input.ctx.globalTools,
      ...(this.input.ctx.workingMemoryTools ?? {}),
      ...this.input.node.localTools,
    };
    try {
      await dispatchModelToolCalls(this.input.ctx, activeCalls, mergedTools, ({ call, outcome }) => {
        outcomes.set(call.toolCallId, { result: outcome.result, failed: outcome.failed });
        this.failures.set(call.toolCallId, outcome.failed);
        this.state.toolResults.push({
          name: call.toolName,
          args: call.input,
          result: outcome.result,
          toolCallId: call.toolCallId,
        });
        this.state.toolCallsMade.push({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          args: call.input,
          result: outcome.result,
          success: !outcome.failed,
          timestamp: Date.now(),
        });
        this.state.control ??= outcome.control;
        this.state.toolMessages.push(kuralleResultMessage(call, outcome.result, outcome.failed));
      });
    } catch (error) {
      this.signal = error;
      try {
        await this.input.ctx.attachInterruptContinuation(this.state.toolMessages);
      } catch (continuationError) {
        this.signal = continuationError;
      }
    }

    const terminate = Boolean(this.state.control || this.signal);
    for (const call of activeCalls) {
      const deferred = this.registrations.get(call.toolCallId)!;
      const outcome = outcomes.get(call.toolCallId);
      if (outcome) deferred.resolve({ ...outcome, terminate });
      else deferred.resolve({ result: { interrupted: true }, failed: false, terminate: true });
    }
    this.completed = true;
  }
}

function addUsage(current: ModelTurnLoopState['usage'], usage: Usage): ModelTurnLoopState['usage'] {
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  const next = {
    inputTokens: (current?.inputTokens ?? 0) + inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + usage.output,
    totalTokens: (current?.totalTokens ?? 0) + usage.totalTokens,
    cacheReadTokens: (current?.cacheReadTokens ?? 0) + usage.cacheRead,
    cacheWriteTokens: (current?.cacheWriteTokens ?? 0) + usage.cacheWrite,
    contextTokens: Math.max(current?.contextTokens ?? 0, inputTokens),
  };
  return next;
}

function modelId(model: Model<Api>): string {
  return `${model.provider}:${model.id}`;
}

export class PiModelTurnLoop implements ModelTurnLoop {
  private readonly streamFn;

  constructor(private readonly config: PiDriverConfig) {
    this.streamFn = resolvePiStreamFn(config);
  }

  async run(
    input: ModelTurnLoopInput,
    state: ModelTurnLoopState,
    emitToken: (delta: string) => void,
  ): Promise<void> {
    const model = typeof this.config.model === 'function'
      ? await this.config.model({
          purpose: input.purpose,
          languageModel: input.model,
          node: input.node.node,
          ctx: input.ctx,
        })
      : this.config.model;
    const systemPrompt = [
      ...input.system.map((message) => String(message.content ?? '')),
      ...input.volatileSystemBlocks.filter((block): block is string => Boolean(block?.trim())),
    ].join('\n\n');
    const messages = aiMessagesToPi(input.messages);
    if (messages.length === 0 || messages.at(-1)?.role === 'assistant') {
      messages.push({
        role: 'user',
        content: 'Continue according to the current runtime instructions.',
        timestamp: Date.now(),
      });
    }

    const batch = new KuralleToolBatch(input, state);
    const tools = await this.createTools(input, batch);
    let step = 0;
    let callId: string | undefined;
    let lastAssistant: AssistantMessage | undefined;

    const emit = async (event: AgentEvent): Promise<void> => {
      if (event.type === 'turn_start') {
        callId = crypto.randomUUID();
        input.ctx.emit({
          channel: 'internal',
          type: 'model-call-start',
          payload: { callId, modelId: modelId(model), step },
        });
      }
      if (
        event.type === 'message_update' &&
        event.assistantMessageEvent.type === 'text_delta'
      ) {
        emitToken(event.assistantMessageEvent.delta);
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        lastAssistant = event.message;
        batch.setAssistant(event.message);
        if (event.message.content.some((part) => part.type === 'toolCall')) {
          state.toolMessages.push(piAssistantToAi(event.message));
        }
      }
      if (
        event.type === 'message_end' &&
        event.message.role === 'toolResult' &&
        !batch.wasDispatched(event.message.toolCallId)
      ) {
        state.toolMessages.push(piToolResultToAi(event.message));
      }
      if (event.type === 'tool_execution_end' && !batch.wasDispatched(event.toolCallId)) {
        this.recordPiRejectedTool(input, state, batch, event);
      }
      if (event.type === 'turn_end' && event.message.role === 'assistant') {
        state.usage = addUsage(state.usage, event.message.usage);
        input.ctx.emit({
          channel: 'internal',
          type: 'model-call-end',
          payload: {
            callId: callId ?? crypto.randomUUID(),
            finishReason: event.message.stopReason,
            inputTokens: event.message.usage.input + event.message.usage.cacheRead + event.message.usage.cacheWrite,
            outputTokens: event.message.usage.output,
            ...(event.message.usage.cacheRead > 0 ? { cacheReadTokens: event.message.usage.cacheRead } : {}),
            ...(event.message.usage.cacheWrite > 0 ? { cacheWriteTokens: event.message.usage.cacheWrite } : {}),
          },
        });
        step += 1;
        callId = undefined;
      }
    };

    const loopConfig: AgentLoopConfig = {
      model,
      reasoning: this.config.thinkingLevel === 'off' ? undefined : this.config.thinkingLevel,
      sessionId: input.ctx.session.id,
      toolExecution: 'parallel',
      convertToLlm: (value) => value as Message[],
      getApiKey: this.config.getApiKey,
      afterToolCall: async ({ toolCall }) => {
        const failed = batch.failed(toolCall.id);
        return failed === undefined ? undefined : { isError: failed };
      },
      shouldStopAfterTurn: async () => {
        if (batch.takeSignal() || state.control || step >= input.maxSteps) return true;
        return input.stopAfterToolResults?.(state) ?? false;
      },
    };

    try {
      await runAgentLoopContinue(
        { systemPrompt, messages, tools },
        loopConfig,
        emit,
        input.ctx.abortSignal,
        this.streamFn,
      );
    } catch (error) {
      if (callId) {
        input.ctx.emit({
          channel: 'internal',
          type: 'model-call-end',
          payload: { callId, finishReason: 'error' },
        });
        callId = undefined;
      }
      throw error;
    }

    const signal = batch.takeSignal();
    if (signal) throw signal;
    if (lastAssistant?.stopReason === 'error' || lastAssistant?.stopReason === 'aborted') {
      throw new Error(lastAssistant.errorMessage ?? `Pi model stopped: ${lastAssistant.stopReason}`);
    }
  }

  private recordPiRejectedTool(
    input: ModelTurnLoopInput,
    state: ModelTurnLoopState,
    batch: KuralleToolBatch,
    event: Extract<AgentEvent, { type: 'tool_execution_end' }>,
  ): void {
    const call = batch.call(event.toolCallId) ?? {
      toolName: event.toolName,
      input: {},
      toolCallId: event.toolCallId,
    };
    const result = piFailureResult(event.result as AgentToolResult<unknown>);
    input.ctx.emit({
      channel: 'internal',
      type: 'tool-call',
      payload: { toolName: call.toolName, args: call.input, toolCallId: call.toolCallId },
    });
    state.toolResults.push({
      name: call.toolName,
      args: call.input,
      result,
      toolCallId: call.toolCallId,
    });
    state.toolCallsMade.push({
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      args: call.input,
      result,
      success: false,
      timestamp: Date.now(),
    });
    input.ctx.emit({
      channel: 'internal',
      type: 'tool-result',
      payload: { toolName: call.toolName, result, toolCallId: call.toolCallId },
    });
  }

  private async createTools(
    input: ModelTurnLoopInput,
    batch: KuralleToolBatch,
  ): Promise<AgentTool<TSchema>[]> {
    const entries = Object.entries(input.tools ?? {});
    return Promise.all(entries.map(async ([name, definition]) => {
      if (!('inputSchema' in definition)) {
        throw new Error(`PiDriver cannot adapt provider-defined tool "${name}"`);
      }
      const parameters = await asSchema(definition.inputSchema).jsonSchema;
      return {
        name,
        label: name,
        description: definition.description ?? name,
        parameters: parameters as AgentTool<TSchema>['parameters'],
        executionMode: 'parallel' as const,
        async execute(toolCallId: string) {
          const outcome = await batch.execute(toolCallId);
          return {
            content: [{ type: 'text' as const, text: resultText(outcome.result) }],
            details: outcome.result,
            terminate: outcome.terminate,
          };
        },
      };
    }));
  }
}
