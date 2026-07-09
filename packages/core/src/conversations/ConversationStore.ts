import crypto from 'node:crypto';

import type { ChannelId, Session } from '../types/index.js';

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ConversationStore {
  resolveConversationId(opts: {
    userId: string;
    channelId: ChannelId;
    windowMs?: number;
  }): Promise<string>;
  closeConversation(conversationId: string): Promise<void>;
  listSessions(conversationId: string): Promise<Session[]>;
}

interface ConversationRecord {
  conversationId: string;
  lastActiveAt: number;
}

export class InMemoryConversationStore implements ConversationStore {
  private activeByUser = new Map<string, ConversationRecord>();
  private sessionsByConversation = new Map<string, Map<string, Session>>();

  async resolveConversationId(opts: {
    userId: string;
    channelId: ChannelId;
    windowMs?: number;
  }): Promise<string> {
    const now = Date.now();
    const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    const key = userConversationKey(opts.userId);
    const existing = this.activeByUser.get(key);

    if (existing && now - existing.lastActiveAt < windowMs) {
      existing.lastActiveAt = now;
      return existing.conversationId;
    }

    const conversationId = `conv-${crypto.randomBytes(12).toString('base64url')}`;
    this.activeByUser.set(key, { conversationId, lastActiveAt: now });
    return conversationId;
  }

  async closeConversation(conversationId: string): Promise<void> {
    for (const [key, record] of this.activeByUser.entries()) {
      if (record.conversationId === conversationId) {
        this.activeByUser.delete(key);
      }
    }
  }

  async listSessions(conversationId: string): Promise<Session[]> {
    const sessions = this.sessionsByConversation.get(conversationId);
    if (!sessions) return [];
    return Array.from(sessions.values())
      .map(session => safeClone(session))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async upsertSession(session: Session): Promise<void> {
    const sessions = this.sessionsByConversation.get(session.conversationId) ?? new Map<string, Session>();
    sessions.set(session.id, safeClone(session));
    this.sessionsByConversation.set(session.conversationId, sessions);
  }
}

function userConversationKey(userId: string): string {
  return `${userId}:any`;
}

function safeClone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value, (_key, val) => {
      if (typeof val === 'function' || val instanceof Promise) return undefined;
      return val;
    }));
  }
}
