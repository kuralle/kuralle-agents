import type { HarnessStreamPart, RunContext, Session } from '../types/index.js';

/**
 * Discriminated union of conversation-level events for the runtime event log.
 * Stored in session workingMemory for observability.
 */
export type ConversationEvent =
  | { type: 'user'; text: string; userId?: string; timestamp: Date }
  | { type: 'assistant'; text: string; timestamp: Date }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: unknown; timestamp: Date }
  | { type: 'tool-result'; toolCallId: string; toolName: string; result: unknown; timestamp: Date }
  | { type: 'tool-error'; toolCallId: string; toolName: string; error: string; timestamp: Date }
  | { type: 'handoff'; from: string; to: string; reason?: string; timestamp: Date }
  | { type: 'flow-transition'; from: string; to: string; timestamp: Date }
  | { type: 'error'; error: string; timestamp: Date };

/**
 * Records conversation events into session working memory and manages checkpointing.
 * Shared by Runtime and VoiceEngine.
 */
export interface ConversationEventLog {
  /**
   * Record a stream part into the session's runtime event log.
   * Text-deltas are accumulated; terminal events flush the assistant text.
   */
  record(context: RunContext, part: HarnessStreamPart): void;

  /**
   * Persist the session as a checkpoint (called after significant events).
   */
  checkpoint(session: Session): Promise<void>;

  /**
   * Whether a given stream part type should trigger a checkpoint save.
   */
  shouldCheckpoint(part: HarnessStreamPart): boolean;

  /**
   * Clean up transient state (e.g., accumulated assistant text) from the session.
   */
  cleanup(session: Session): void;
}
