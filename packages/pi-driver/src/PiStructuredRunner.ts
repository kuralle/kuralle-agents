import {
  runAgentLoopContinue,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentTool,
} from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, Message, Model, TSchema } from '@earendil-works/pi-ai';
import { asSchema } from 'ai';
import type { DecideNode, RunContext } from '@kuralle-agents/core';
import { buildDecideSystem, prepareStructuredDecide } from '@kuralle-agents/core/runtime';
import { aiMessagesToPi } from './messages.js';
import type { PiDriverConfig } from './types.js';
import { resolvePiStreamFn } from './streamFn.js';

const SUBMIT_DECISION = '__submit_structured_decision';

function modelId(model: Model<Api>): string {
  return `${model.provider}:${model.id}`;
}

export class PiStructuredRunner {
  private readonly streamFn;

  constructor(private readonly config: PiDriverConfig) {
    this.streamFn = resolvePiStreamFn(config);
  }

  async run(node: DecideNode, ctx: RunContext): Promise<unknown> {
    const prepared = prepareStructuredDecide(node, ctx);
    if (prepared.kind === 'immediate') return prepared.value;

    const model = typeof this.config.model === 'function'
      ? await this.config.model({
          purpose: 'structured',
          languageModel: ctx.controlModel,
          node,
          ctx,
        })
      : this.config.model;
    const schema = asSchema(prepared.schema);
    const parameters = await schema.jsonSchema;
    let submitted: unknown;
    let lastAssistant: AssistantMessage | undefined;
    let turns = 0;
    let submissionRetries = 0;
    const maxSubmissionRetries = 2;
    const tool: AgentTool<TSchema> = {
      name: SUBMIT_DECISION,
      label: 'Submit structured decision',
      description: 'Submit the structured decision. You must call this tool exactly once.',
      parameters: parameters as AgentTool<TSchema>['parameters'],
      executionMode: 'sequential',
      async execute(_toolCallId, args) {
        submitted = args;
        return {
          content: [{ type: 'text', text: 'Decision accepted.' }],
          details: args,
          terminate: true,
        };
      },
    };
    const messages = aiMessagesToPi(ctx.runState.messages);
    if (messages.length === 0 || messages.at(-1)?.role === 'assistant') {
      messages.push({
        role: 'user',
        content: 'Make the pending structured decision now.',
        timestamp: Date.now(),
      });
    }
    const systemPrompt = [
      ...buildDecideSystem(node, ctx).map((message) => String(message.content ?? '')),
      `Return no prose. Call ${SUBMIT_DECISION} exactly once with the decision object.`,
    ].join('\n\n');
    let callId: string | undefined;

    const emit = async (event: AgentEvent): Promise<void> => {
      if (event.type === 'turn_start') {
        callId = crypto.randomUUID();
        ctx.emit({
          channel: 'internal',
          type: 'model-call-start',
          payload: { callId, modelId: modelId(model), step: turns },
        });
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        lastAssistant = event.message;
      }
      if (event.type === 'turn_end' && event.message.role === 'assistant') {
        turns += 1;
        ctx.emit({
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
        callId = undefined;
      }
    };
    const loopConfig: AgentLoopConfig = {
      model,
      reasoning: this.config.thinkingLevel === 'off' ? undefined : this.config.thinkingLevel,
      sessionId: ctx.session.id,
      toolExecution: 'sequential',
      convertToLlm: (value) => value as Message[],
      getApiKey: this.config.getApiKey,
      shouldStopAfterTurn: () => turns >= (this.config.maxSteps ?? 5),
      getFollowUpMessages: async () => {
        if (submitted !== undefined || submissionRetries >= maxSubmissionRetries) return [];
        submissionRetries += 1;
        return [{
          role: 'user',
          content:
            `Your previous response did not call ${SUBMIT_DECISION}. ` +
            `Return no prose. Call ${SUBMIT_DECISION} exactly once now with an object matching its schema.`,
          timestamp: Date.now(),
        }];
      },
    };

    try {
      await runAgentLoopContinue(
        { systemPrompt, messages, tools: [tool] },
        loopConfig,
        emit,
        ctx.abortSignal,
        this.streamFn,
      );
    } catch (error) {
      if (callId) {
        ctx.emit({
          channel: 'internal',
          type: 'model-call-end',
          payload: { callId, finishReason: 'error' },
        });
        callId = undefined;
      }
      throw error;
    }

    if (lastAssistant?.stopReason === 'error' || lastAssistant?.stopReason === 'aborted') {
      throw new Error(lastAssistant.errorMessage ?? `Pi model stopped: ${lastAssistant.stopReason}`);
    }
    if (submitted === undefined) {
      throw new Error(`Pi structured decision did not call ${SUBMIT_DECISION}`);
    }
    if (!schema.validate) return submitted;
    const validated = await schema.validate(submitted);
    if (!validated.success) throw validated.error;
    return validated.value;
  }
}
