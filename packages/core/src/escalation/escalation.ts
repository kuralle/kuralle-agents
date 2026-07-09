import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import type { Session, SessionMetadata } from '../types/session.js';
import type { RunState } from '../runtime/durable/types.js';
import type {
  EscalationConfig,
  EscalationOutcome,
  EscalationReason,
  EscalationRequest,
} from './types.js';

/** One-shot latch: set when the handler fired at flow-escalate pause time, so
 *  the post-resume terminal handoff does not notify a second time. */
export const ESCALATION_NOTIFIED_KEY = '__escalationNotified';

const SUMMARY_PROMPT = [
  'Write a concise handoff brief for a human agent taking over this conversation.',
  'Cover: who the user is (if known), what they want, what has been done or promised',
  '(with exact ids/amounts), why this is being escalated, and the next action the human should take.',
  'Maximum 120 words. Do not invent details.',
].join(' ');

function textProjection(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Array<Record<string, unknown>>)
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join(' ');
}

export function ensureSessionMetadata(session: Session): SessionMetadata {
  if (!session.metadata) {
    const now = new Date();
    session.metadata = {
      createdAt: now,
      lastActiveAt: now,
      totalTokens: 0,
      totalSteps: 0,
      handoffHistory: [],
    };
  }
  return session.metadata;
}

export interface BuildEscalationRequestOptions {
  session: Session;
  runState: RunState;
  reason: string;
  category?: EscalationReason;
  config: EscalationConfig;
  /** Resolved summary model (config.model → controlModel → model → defaultModel). */
  model?: LanguageModel;
  abortSignal?: AbortSignal;
}

export async function buildEscalationRequest(
  options: BuildEscalationRequestOptions,
): Promise<EscalationRequest> {
  const { session, runState, reason, category, config, model } = options;
  const recentCount = config.recentMessageCount ?? 12;

  const recentMessages = runState.messages
    .slice(-recentCount)
    .map((message) => ({ role: message.role, content: textProjection(message.content) }))
    .filter((message) => message.content.trim().length > 0);

  const state: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(runState.state)) {
    if (!key.startsWith('__')) {
      state[key] = value;
    }
  }

  let summary: string | undefined;
  const summarize = config.summarize ?? true;
  if (summarize && model && recentMessages.length > 0) {
    try {
      const transcript = recentMessages
        .map((message) => `${message.role}: ${message.content}`)
        .join('\n');
      const result = await generateText({
        model,
        system: SUMMARY_PROMPT,
        prompt: `Escalation reason: ${reason}\n\nConversation:\n${transcript}`,
        abortSignal: options.abortSignal,
      });
      summary = result.text.trim() || undefined;
    } catch {
      summary = undefined; // the handoff proceeds without a brief — never blocks on the summarizer
    }
  }

  return {
    sessionId: session.id,
    userId: session.userId,
    agentId: runState.activeAgentId,
    reason,
    category,
    summary,
    state,
    recentMessages,
    at: new Date().toISOString(),
  };
}

export function recordEscalationOutcome(
  session: Session,
  category: EscalationReason,
  outcome: EscalationOutcome,
): void {
  const metadata = ensureSessionMetadata(session);
  metadata.lastEscalation = {
    at: new Date().toISOString(),
    reason: category,
    handlerOutcome: outcome.status,
  };
}
