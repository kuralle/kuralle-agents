import type { Session, SessionStore } from '@kuralle-agents/core';
import type { OwnershipStore, OutboundMiddleware } from '@kuralle-agents/messaging';

export const OWNERSHIP_WM_KEY = '__ownership';

function loadOrCreate(sessionStore: SessionStore, threadId: string): Promise<Session> {
  return sessionStore.get(threadId).then((session) => {
    if (session) return session;
    const now = new Date();
    return {
      id: threadId,
      conversationId: threadId,
      channelId: 'api',
      createdAt: now,
      updatedAt: now,
      messages: [],
      workingMemory: {},
      currentAgent: 'main',
      agentStates: {},
      handoffHistory: [],
      metadata: {
        createdAt: now,
        lastActiveAt: now,
        totalTokens: 0,
        totalSteps: 0,
        handoffHistory: [],
      },
    };
  });
}

export function sessionOwnershipStore(sessionStore: SessionStore): OwnershipStore {
  return {
    async owner(threadId) {
      const session = await sessionStore.get(threadId);
      if (!session) return 'bot';
      return session.workingMemory[OWNERSHIP_WM_KEY] === 'human' ? 'human' : 'bot';
    },
    async claim(threadId, by) {
      const session = await loadOrCreate(sessionStore, threadId);
      session.workingMemory[OWNERSHIP_WM_KEY] = by;
      session.updatedAt = new Date();
      await sessionStore.save(session);
    },
    async release(threadId) {
      const session = await sessionStore.get(threadId);
      if (!session) return;
      delete session.workingMemory[OWNERSHIP_WM_KEY];
      session.updatedAt = new Date();
      await sessionStore.save(session);
    },
  };
}

export function ownershipGate(ownership: OwnershipStore): OutboundMiddleware {
  return {
    name: 'ownership-gate',
    async send(req, next) {
      if ((await ownership.owner(req.threadId)) === 'human') {
        return { kind: 'suppressed', reason: 'human-owned' };
      }
      return next(req);
    },
  };
}
