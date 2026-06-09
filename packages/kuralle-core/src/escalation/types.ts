import type { LanguageModel } from 'ai';

export type EscalationReason = 'low-confidence' | 'user-request' | 'frustration' | 'tool-call' | 'safety-block';

export type EscalationOutcome =
  | { status: 'queued'; queueId: string; estimatedWaitSec?: number }
  | { status: 'connected'; operatorId: string }
  | { status: 'failed'; error: string };

/**
 * The handoff package built when a conversation escalates to a human:
 * everything the receiving agent needs to take over without re-asking.
 */
export interface EscalationRequest {
  sessionId: string;
  userId?: string;
  agentId: string;
  /** Free-form reason from the triggering control (tool call, validator, flow transition). */
  reason: string;
  /** Typed category when the trigger provided one. */
  category?: EscalationReason;
  /** LLM-generated handoff brief (when summarization is enabled and a model is available). */
  summary?: string;
  /** Collected flow state snapshot (internal `__`-prefixed keys excluded). */
  state: Record<string, unknown>;
  /** Recent conversation tail as a text projection, oldest first. */
  recentMessages: Array<{ role: string; content: string }>;
  /** ISO8601 timestamp. */
  at: string;
}

/**
 * Host-provided escalation sink: queue a ticket, claim thread ownership,
 * page an operator. Must not throw for expected failures — return
 * `{ status: 'failed', error }` instead (the runtime also catches).
 */
export type EscalationHandler = (request: EscalationRequest) => Promise<EscalationOutcome>;

export interface EscalationConfig {
  handler: EscalationHandler;
  /** Generate the LLM handoff brief. Default: true. */
  summarize?: boolean;
  /** Summary model. Default: the active agent's controlModel → model → defaultModel. */
  model?: LanguageModel;
  /** Recent messages included in the request. Default: 12. */
  recentMessageCount?: number;
}
