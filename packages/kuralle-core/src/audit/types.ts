import type { ConversationOutcome, ConversationOutcomeMarkedBy } from '../outcomes/types.js';
import type { ChannelId } from '../types/session.js';

export interface AuditEntryBase {
  readonly at: string;
  readonly sessionId: string;
  readonly conversationId?: string;
  readonly userId?: string;
  readonly agentId?: string;
  readonly turnIndex?: number;
  readonly systemPromptHash?: string;
  readonly systemPrompt?: string;
}

export type AuditEscalationReason =
  | 'low-confidence'
  | 'user-request'
  | 'frustration'
  | 'tool-call'
  | 'safety-block';

export type ConversationAuditEntry =
  | (AuditEntryBase & { type: 'agent-start'; activePersona?: string })
  | (AuditEntryBase & { type: 'agent-end'; finishReason: string })
  | (AuditEntryBase & { type: 'handoff'; from: string; to: string; reason: string })
  | (AuditEntryBase & {
      type: 'refinement';
      aggregate: 'continue' | 'rewrite' | 'escalate' | 'block';
      confidence: number;
      rationale: string;
      rewrittenFrom?: string;
      rewrittenTo?: string;
    })
  | (AuditEntryBase & {
      type: 'validation';
      aggregate: 'continue' | 'rewrite' | 'block';
      confidence: number;
      rationale: string;
      moderator?: string;
    })
  | (AuditEntryBase & {
      type: 'safety-block';
      moderator: string;
      rationale: string;
      userFacingMessage: string;
    })
  | (AuditEntryBase & {
      type: 'safety-rewrite';
      moderator: string;
      beforeLen: number;
      afterLen: number;
      before?: string;
      after?: string;
    })
  | (AuditEntryBase & {
      type: 'escalation';
      reason: AuditEscalationReason;
      confidence?: number;
      handlerOutcome?: 'queued' | 'connected' | 'failed';
    })
  | (AuditEntryBase & {
      type: 'tool-call';
      toolName: string;
      arguments: unknown;
      resultPreview: string;
      status: 'ok' | 'error';
      errorMessage?: string;
      latencyMs: number;
    })
  | (AuditEntryBase & { type: 'knowledge-citation'; sourceId: string; title?: string; score?: number })
  | (AuditEntryBase & {
      type: 'knowledge-no-results';
      query: string;
      reason: 'empty-corpus' | 'no-match' | 'retriever-error';
    })
  | (AuditEntryBase & { type: 'persona-applied'; personaName: string; experimentCohort?: 'control' | 'variant' })
  | (AuditEntryBase & { type: 'channel-switch'; from: ChannelId; to: ChannelId })
  | (AuditEntryBase & {
      type: 'channel-policy-applied';
      channelId: ChannelId;
      changes: Array<'strip-markdown' | 'strip-emojis' | 'truncate' | 'custom'>;
      beforeLen: number;
      afterLen: number;
    })
  | (AuditEntryBase & {
      type: 'procedure-step';
      procedureId: string;
      stepId: string;
      outcome: 'enter' | 'exit' | 'failed';
    })
  | (AuditEntryBase & {
      type: 'procedure-lifecycle';
      procedureId: string;
      outcome: 'start' | 'end';
      status?: 'success' | 'aborted' | 'escalated';
    })
  | (AuditEntryBase & {
      type: 'compaction';
      strategy: 'truncate' | 'summarize';
      tokensBefore: number;
      tokensAfter: number;
      savingsPct: number;
    })
  | (AuditEntryBase & {
      type: 'outcome-marked';
      outcome: ConversationOutcome;
      reason?: string;
      markedBy: ConversationOutcomeMarkedBy;
    });

export type ConversationAuditLog = ConversationAuditEntry[];
export type AuditEntryType = ConversationAuditEntry['type'];

export interface AuditListOptions {
  types?: string[];
  from?: Date;
  to?: Date;
}

export interface AuditReplayOptions extends AuditListOptions {
  order?: 'asc' | 'desc';
}

export interface AuditConfig {
  enabled?: boolean;
  redactPii?: boolean;
  maxResultBytes?: number;
  captureToolArgs?: boolean;
  captureToolResults?: boolean;
  excludeTypes?: string[];
  inlineMaxEntries?: number;
  sync?: boolean;
  captureSystemPrompt?: boolean;
}
