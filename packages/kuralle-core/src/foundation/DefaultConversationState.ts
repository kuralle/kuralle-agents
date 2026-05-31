import crypto from 'node:crypto';
import type { ModelMessage } from 'ai';
import type { ChannelId, Session, WorkingMemory } from '../types/index.js';
import type { SessionStore } from '../session/SessionStore.js';
import type { ConversationState } from './ConversationState.js';
import { SessionWorkingMemory } from '../runtime/WorkingMemory.js';
import { normalizeModelMessage } from '../utils/messageNormalization.js';

/** Internal working memory key for turn tracking. */
const SESSION_TURN_KEY = '__ariaSessionTurn';

export interface DefaultConversationStateConfig {
  sessionStore: SessionStore;
  defaultAgentId: string;
}

/**
 * Default conversation state implementation extracted from Runtime.
 *
 * Handles:
 * - Session load/create/save/delete via SessionStore
 * - Message appending with normalization
 * - Turn counting
 * - Working memory access
 */
export class DefaultConversationState implements ConversationState {
  private sessionStore: SessionStore;
  private defaultAgentId: string;

  constructor(config: DefaultConversationStateConfig) {
    this.sessionStore = config.sessionStore;
    this.defaultAgentId = config.defaultAgentId;
  }

  async load(sessionId: string, userId?: string): Promise<Session> {
    const existing = await this.sessionStore.get(sessionId);
    if (existing) {
      return existing;
    }
    return this.createSession(sessionId, this.defaultAgentId, userId);
  }

  async save(session: Session): Promise<void> {
    this.touchSession(session);
    await this.sessionStore.save(session);
  }

  async delete(sessionId: string): Promise<void> {
    await this.sessionStore.delete(sessionId);
  }

  workingMemory(session: Session): WorkingMemory {
    return new SessionWorkingMemory(session);
  }

  appendUserMessage(session: Session, text: string): void {
    const message: ModelMessage = {
      role: 'user',
      content: [{ type: 'text', text }],
    };
    this.appendMessage(session, message);
  }

  appendAssistantMessage(session: Session, text: string): void {
    const message: ModelMessage = {
      role: 'assistant',
      content: [{ type: 'text', text }],
    };
    this.appendMessage(session, message);
  }

  appendMessage(session: Session, message: ModelMessage): void {
    const normalized = normalizeModelMessage(message);
    if (normalized) {
      session.messages.push(normalized);
      this.touchSession(session);
    }
  }

  getSessionTurn(session: Session): number {
    const value = session.workingMemory[SESSION_TURN_KEY];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  bumpSessionTurn(session: Session): number {
    const next = this.getSessionTurn(session) + 1;
    session.workingMemory[SESSION_TURN_KEY] = next;
    this.touchSession(session);
    return next;
  }

  touchSession(session: Session): void {
    const now = new Date();
    session.updatedAt = now;
    if (session.metadata) {
      session.metadata.lastActiveAt = now;
    }
  }

  createSession(id: string, defaultAgentId: string, userId?: string, opts?: { channelId?: ChannelId; conversationId?: string }): Session {
    const now = new Date();
    const channelId = opts?.channelId ?? 'web';
    const conversationId = opts?.conversationId ?? id;
    return {
      id,
      conversationId,
      channelId,
      userId,
      messages: [],
      createdAt: now,
      updatedAt: now,
      workingMemory: {},
      currentAgent: defaultAgentId,
      activeAgentId: defaultAgentId,
      state: {},
      metadata: {
        createdAt: now,
        lastActiveAt: now,
        totalTokens: 0,
        totalSteps: 0,
        handoffHistory: [],
      },
      agentStates: {},
      handoffHistory: [],
    };
  }
}
