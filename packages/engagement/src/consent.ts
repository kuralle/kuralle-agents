import type { Session, SessionStore } from '@kuralle-agents/core';
import type { ConsentStore, OutboundMiddleware } from '@kuralle-agents/messaging';

export const CONSENT_WM_KEY = '__consentOptedIn';

function consentSessionId(customerId: string): string {
  return `consent:${customerId}`;
}

function loadOrCreate(sessionStore: SessionStore, customerId: string): Promise<Session> {
  const id = consentSessionId(customerId);
  return sessionStore.get(id).then((session) => {
    if (session) return session;
    const now = new Date();
    return {
      id,
      conversationId: id,
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

/**
 * SessionStore-backed consent keyed by customerId.
 * Default when unset: opted-out (`defaultOptedIn: false`) per REQ-11.
 */
export function sessionConsentStore(
  sessionStore: SessionStore,
  opts?: { defaultOptedIn?: boolean },
): ConsentStore {
  const defaultOptedIn = opts?.defaultOptedIn ?? false;

  return {
    async isOptedIn(customerId) {
      const session = await sessionStore.get(consentSessionId(customerId));
      if (!session) return defaultOptedIn;
      const flag = session.workingMemory[CONSENT_WM_KEY];
      if (flag === true) return true;
      if (flag === false) return false;
      return defaultOptedIn;
    },
    async optOut(customerId) {
      const session = await loadOrCreate(sessionStore, customerId);
      session.workingMemory[CONSENT_WM_KEY] = false;
      session.updatedAt = new Date();
      await sessionStore.save(session);
    },
    async optIn(customerId) {
      const session = await loadOrCreate(sessionStore, customerId);
      session.workingMemory[CONSENT_WM_KEY] = true;
      session.updatedAt = new Date();
      await sessionStore.save(session);
    },
  };
}

export function consentGate(consent: ConsentStore): OutboundMiddleware {
  return {
    name: 'consent-gate',
    async send(req, next) {
      const customerId = req.meta.userId;
      if (!customerId || !(await consent.isOptedIn(customerId))) {
        return { kind: 'deferred', reason: 'not-opted-in' };
      }
      return next(req);
    },
  };
}
