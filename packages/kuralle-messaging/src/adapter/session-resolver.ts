import type { InboundMessage, SessionResolver } from '../types.js';

/**
 * Default session resolver that maps inbound messages to Kuralle sessions.
 *
 * Session ID format: `{platform}:{threadId}` — ensures uniqueness across
 * platforms even when thread IDs collide (e.g. phone numbers used as both
 * WhatsApp and SMS thread IDs).
 *
 * User ID is taken from the message sender's contact ID.
 */
export const defaultSessionResolver: SessionResolver = {
  async resolve(message: InboundMessage): Promise<{ sessionId: string; userId?: string }> {
    return {
      sessionId: `${message.platform}:${message.threadId}`,
      userId: message.from.id,
    };
  },
};

// Re-export for convenience
export type { SessionResolver } from '../types.js';
