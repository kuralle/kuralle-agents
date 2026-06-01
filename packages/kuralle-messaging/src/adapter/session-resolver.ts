import type { InboundMessage, SessionResolver } from '../types.js';

/**
 * Default session resolver that maps inbound messages to Kuralle sessions.
 *
 * `threadId` is already platform-scoped (e.g. `whatsapp:{phoneNumberId}:{from}`).
 * User ID prefers {@link InboundMessage.customerId} over {@link ContactInfo.id}.
 */
export const defaultSessionResolver: SessionResolver = {
  async resolve(message: InboundMessage): Promise<{ sessionId: string; userId?: string }> {
    return {
      sessionId: message.threadId,
      userId: message.customerId ?? message.from.id,
    };
  },
};

// Re-export for convenience
export type { SessionResolver } from '../types.js';
