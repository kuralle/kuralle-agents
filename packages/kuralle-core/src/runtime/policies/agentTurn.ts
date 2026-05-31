import type { ModelMessage } from 'ai';
import type { ToolCallRecord } from '../../types/session.js';
import type { RunContext } from '../../types/run-context.js';
import { runInputProcessors, runOutputProcessors } from '../../processors/ProcessorRunner.js';

export interface PreTurnResult {
  proceed: boolean;
  userMessage: string;
  blockedMessage?: string;
}

export interface PostTurnResult {
  proceed: boolean;
  text: string;
  blockedMessage?: string;
}

function latestUserMessage(messages: ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user' && typeof message.content === 'string') {
      return message.content;
    }
  }
  return '';
}

async function runRefinementPolicies(
  ctx: RunContext,
  userMessage: string,
): Promise<PreTurnResult> {
  const policies = ctx.refinementPolicies ?? [];
  if (policies.length === 0) {
    return { proceed: true, userMessage };
  }

  const sorted = [...policies].sort((a, b) => a.name.localeCompare(b.name));
  let current = userMessage;

  for (const policy of sorted) {
    const decision = await policy.refine({
      session: ctx.session,
      userMessage: current,
      knowledgeProvider: undefined,
      memoryService: undefined,
      abortSignal: ctx.abortSignal,
    });

    if (decision.decision === 'block') {
      return {
        proceed: false,
        userMessage: current,
        blockedMessage: decision.userFacingMessage ?? decision.rationale ?? 'Input blocked',
      };
    }
    if (decision.decision === 'rewrite') {
      current = decision.rewrittenMessage;
    }
  }

  return { proceed: true, userMessage: current };
}

async function runValidationPolicies(
  ctx: RunContext,
  userMessage: string,
  assistantOutput: string,
  toolCallsMade: ToolCallRecord[],
): Promise<PostTurnResult> {
  const policies = ctx.validationPolicies ?? [];
  if (policies.length === 0) {
    return { proceed: true, text: assistantOutput };
  }

  const sorted = [...policies].sort((a, b) => a.name.localeCompare(b.name));
  let current = assistantOutput;

  for (const policy of sorted) {
    const decision = await policy.validate({
      session: ctx.session,
      userMessage,
      assistantOutput: current,
      toolCallsMade,
      knowledgeCitations: [],
      abortSignal: ctx.abortSignal,
    });

    if (decision.decision === 'block') {
      return {
        proceed: false,
        text: decision.userFacingMessage ?? '',
        blockedMessage: decision.userFacingMessage ?? decision.rationale,
      };
    }
    if (decision.decision === 'rewrite') {
      current = decision.rewrittenOutput;
    }
  }

  return { proceed: true, text: current };
}

export async function applyPreTurnPolicies(ctx: RunContext): Promise<PreTurnResult> {
  const userMessage = latestUserMessage(ctx.runState.messages);
  const processors = ctx.inputProcessors ?? [];

  if (processors.length > 0) {
    const outcome = await runInputProcessors({
      processors,
      input: userMessage,
      messages: ctx.runState.messages,
      context: {
        session: ctx.session,
        agentId: ctx.runState.activeAgentId,
        abortSignal: ctx.abortSignal,
      },
    });
    if (outcome.blocked) {
      return {
        proceed: false,
        userMessage,
        blockedMessage: outcome.message,
      };
    }
    if (outcome.input !== userMessage) {
      patchLatestUserMessage(ctx.runState.messages, outcome.input);
    }
  }

  return runRefinementPolicies(ctx, latestUserMessage(ctx.runState.messages));
}

export async function applyPostTurnPolicies(
  ctx: RunContext,
  assistantOutput: string,
  toolCallsMade: ToolCallRecord[] = [],
): Promise<PostTurnResult> {
  const userMessage = latestUserMessage(ctx.runState.messages);
  const processors = ctx.outputProcessors ?? [];
  let current = assistantOutput;

  if (processors.length > 0) {
    const outcome = await runOutputProcessors({
      processors,
      text: current,
      messages: ctx.runState.messages,
      context: {
        session: ctx.session,
        agentId: ctx.runState.activeAgentId,
        toolCallHistory: toolCallsMade,
        abortSignal: ctx.abortSignal,
      },
    });
    if (outcome.blocked) {
      return {
        proceed: false,
        text: outcome.message,
        blockedMessage: outcome.message,
      };
    }
    current = outcome.text;
  }

  return runValidationPolicies(ctx, userMessage, current, toolCallsMade);
}

function patchLatestUserMessage(messages: ModelMessage[], next: string): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') {
      messages[index] = { role: 'user', content: next };
      return;
    }
  }
  messages.push({ role: 'user', content: next });
}
