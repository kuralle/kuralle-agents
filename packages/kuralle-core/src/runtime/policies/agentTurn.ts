import type { ModelMessage } from 'ai';
import type { TurnControl } from '../../types/channel.js';
import type { ToolCallRecord } from '../../types/session.js';
import type { SourceRef } from '../../types/voice.js';
import type { RunContext } from '../../types/run-context.js';
import type { ValidateDecision } from '../../capabilities/ValidationCapability.js';
import { appendConversationAudit } from '../../audit/record.js';
import { SAFE_DEGRADED_MESSAGE } from '../../flow/degrade.js';
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
  control?: TurnControl;
  confidence?: number;
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

function auditContext(ctx: RunContext) {
  return {
    sessionId: ctx.session.id,
    conversationId: ctx.session.conversationId,
    userId: ctx.session.userId,
    agentId: ctx.runState.activeAgentId,
  };
}

function recordKnowledgeCitations(ctx: RunContext, citations: SourceRef[]): void {
  for (const citation of citations) {
    appendConversationAudit(ctx.session, auditContext(ctx), {
      type: 'knowledge-citation',
      sourceId: citation.id,
      title: citation.title,
      score: citation.score,
    });
  }
}

function recordValidationDecision(ctx: RunContext, policyName: string, decision: ValidateDecision): void {
  if (decision.decision === 'block') {
    appendConversationAudit(ctx.session, auditContext(ctx), {
      type: 'safety-block',
      moderator: policyName,
      rationale: decision.rationale,
      userFacingMessage: decision.userFacingMessage ?? decision.rationale,
    });
    appendConversationAudit(ctx.session, auditContext(ctx), {
      type: 'validation',
      aggregate: 'block',
      confidence: decision.confidence,
      rationale: decision.rationale,
      moderator: policyName,
    });
    return;
  }

  if (decision.decision === 'escalate') {
    appendConversationAudit(ctx.session, auditContext(ctx), {
      type: 'escalation',
      reason: decision.escalationReason ?? 'low-confidence',
      confidence: decision.confidence,
    });
    appendConversationAudit(ctx.session, auditContext(ctx), {
      type: 'validation',
      aggregate: 'block',
      confidence: decision.confidence,
      rationale: decision.rationale,
      moderator: policyName,
    });
    return;
  }

  appendConversationAudit(ctx.session, auditContext(ctx), {
    type: 'validation',
    aggregate: decision.decision === 'rewrite' ? 'rewrite' : 'continue',
    confidence: decision.confidence,
    rationale: decision.rationale ?? '',
    moderator: policyName,
  });
}

function safeBlockedText(decision: Extract<ValidateDecision, { decision: 'block' | 'escalate' }>): string {
  return decision.userFacingMessage?.trim() || decision.rationale?.trim() || SAFE_DEGRADED_MESSAGE;
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
  knowledgeCitations: SourceRef[],
): Promise<PostTurnResult> {
  const policies = ctx.validationPolicies ?? [];
  if (policies.length === 0) {
    return { proceed: true, text: assistantOutput };
  }

  if (knowledgeCitations.length > 0) {
    recordKnowledgeCitations(ctx, knowledgeCitations);
  }

  const sorted = [...policies].sort((a, b) => a.name.localeCompare(b.name));
  let current = assistantOutput;
  let lastConfidence: number | undefined;

  for (const policy of sorted) {
    const decision = await policy.validate({
      session: ctx.session,
      userMessage,
      assistantOutput: current,
      toolCallsMade,
      knowledgeCitations,
      abortSignal: ctx.abortSignal,
    });

    recordValidationDecision(ctx, policy.name, decision);
    lastConfidence = decision.confidence;

    if (decision.decision === 'block') {
      const safe = safeBlockedText(decision);
      return {
        proceed: false,
        text: safe,
        blockedMessage: safe,
        control: { type: 'recover', reason: decision.rationale },
        confidence: decision.confidence,
      };
    }

    if (decision.decision === 'escalate') {
      const safe = safeBlockedText(decision);
      return {
        proceed: false,
        text: safe,
        blockedMessage: safe,
        control: { type: 'escalate', reason: decision.rationale },
        confidence: decision.confidence,
      };
    }

    if (decision.decision === 'rewrite') {
      current = decision.rewrittenOutput;
    }
  }

  if (ctx.session.metadata) {
    ctx.session.metadata.lastValidationConfidence = lastConfidence;
  }

  return { proceed: true, text: current, confidence: lastConfidence };
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
  knowledgeCitations: SourceRef[] = [],
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

  const citations =
    knowledgeCitations.length > 0 ? knowledgeCitations : (ctx.lastRetrievalCitations ?? []);

  return runValidationPolicies(ctx, userMessage, current, toolCallsMade, citations);
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
