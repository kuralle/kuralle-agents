import type { ConversationOutcome } from '../outcomes/types.js';
import type { ChoiceOption } from './selection.js';
import type { EscalationReason } from '../escalation/types.js';

/**
 * Authoritative runtime stream union (`runFlow` / `Runtime` emit).
 * `types/voice.ts` defines a separate voice/realtime union that intentionally
 * does not include `{ type: 'interactive' }`.
 */
export type HarnessStreamPart =
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'text-cancel'; id: string; reason: string }
  | { type: 'tool-call'; toolName: string; args: unknown; toolCallId?: string }
  | { type: 'tool-result'; toolName: string; result: unknown; toolCallId?: string }
  | { type: 'flow-enter'; flow: string }
  | { type: 'flow-end'; flow: string; reason: string }
  | { type: 'node-enter'; nodeName: string }
  | { type: 'node-exit'; nodeName: string }
  | { type: 'flow-transition'; from: string; to: string }
  | { type: 'handoff'; targetAgent: string; reason?: string }
  | { type: 'interrupted'; reason: string; lastStep: number }
  | { type: 'paused'; waitingFor: string }
  | { type: 'conversation-outcome'; outcome: ConversationOutcome }
  | { type: 'interactive'; nodeId: string; options: ChoiceOption[]; prompt: string }
  | { type: 'turn-end' }
  | { type: 'pipeline-validation-block'; rationale: string; userFacingMessage?: string }
  | {
      type: 'safety-blocked';
      moderator: string;
      rationale: string;
      userFacingMessage: string;
      handlerOutcome?: 'queued' | 'connected' | 'failed';
    }
  | {
      /** An agent-initiated (scheduled wake) turn — there is no new user message. */
      type: 'wake';
      reason: string;
    }
  | {
      type: 'escalation';
      reason: string;
      category?: EscalationReason;
      /** Result of the configured escalation handler. */
      outcome: 'queued' | 'connected' | 'failed';
      /** The LLM handoff brief included in the request, when generated. */
      summary?: string;
    }
  | {
      type: 'context-compacted';
      /** Estimated history tokens before/after compaction. */
      beforeTokens: number;
      afterTokens: number;
      /** Number of older messages folded into the summary. */
      summarizedCount: number;
    }
  | { type: 'compaction-skipped'; reason: string }
  | {
      type: 'context-overflow-recovered';
      /** Partial assistant/tool messages stripped from the failed turn. */
      strippedCount: number;
      /** Whether the forced post-recovery compaction actually compacted. */
      compacted: boolean;
    }
  | { type: 'error'; error: string }
  | { type: 'custom'; name: string; data: unknown }
  | { type: 'done'; sessionId: string };

export interface TurnHandle extends Promise<import('./channel.js').TurnResult> {
  readonly events: AsyncIterable<HarnessStreamPart>;
  toResponseStream(format?: 'sse' | 'ndjson'): ReadableStream;
  toUIMessageStreamResponse(opts?: { sessionId?: string }): Response;
  cancel(reason?: string): void;
}
