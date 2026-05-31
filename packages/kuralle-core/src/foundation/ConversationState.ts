import type { ChannelId, Session, WorkingMemory } from '../types/index.js';
import type { ModelMessage } from 'ai';

/**
 * Manages session lifecycle: load, save, delete, message append, turn counting.
 * Shared by Runtime and VoiceEngine.
 */
export interface ConversationState {
  /** Load an existing session or create a new one. */
  load(sessionId: string, userId?: string): Promise<Session>;

  /** Persist session to the backing store. */
  save(session: Session): Promise<void>;

  /** Delete a session from the backing store. */
  delete(sessionId: string): Promise<void>;

  /** Get a WorkingMemory wrapper for the session. */
  workingMemory(session: Session): WorkingMemory;

  /** Append a user message to the session history. */
  appendUserMessage(session: Session, text: string): void;

  /** Append an assistant message to the session history. */
  appendAssistantMessage(session: Session, text: string): void;

  /** Append a raw ModelMessage to the session history. */
  appendMessage(session: Session, message: ModelMessage): void;

  /** Get the current turn number for the session. */
  getSessionTurn(session: Session): number;

  /** Increment and return the new turn number. */
  bumpSessionTurn(session: Session): number;

  /** Update the session's updatedAt timestamp. */
  touchSession(session: Session): void;

  /** Create a fresh session with defaults. */
  createSession(id: string, defaultAgentId: string, userId?: string, opts?: { channelId?: ChannelId; conversationId?: string }): Session;
}
