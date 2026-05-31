/**
 * @module adapter/session-resolver-chain
 *
 * Chain-of-responsibility session resolver.
 *
 * A `SessionResolverPlugin` gets first crack at each message and may opt out
 * by returning `undefined`. Plugins run in declaration order; the first one
 * that returns a concrete `{ sessionId }` wins. If no plugin matches, the
 * chain throws so the caller doesn't silently fall back to a wrong session.
 *
 * Built-ins:
 * - {@link ThreadIdResolver} — the historical `{platform}:{threadId}` default.
 * - {@link PhoneLookupResolver} — stub that lets integrators hook an E.164
 *   → internal-userId lookup (e.g. Postgres, Supabase). Always defers when
 *   `message.from.phone` is absent.
 */

import type { InboundMessage, SessionResolver } from '../types.js';

/** One link in the chain. Returning `undefined` defers to the next plugin. */
export interface SessionResolverPlugin {
  readonly name: string;
  tryResolve(
    message: InboundMessage,
  ): Promise<{ sessionId: string; userId?: string } | undefined>;
}

/**
 * Chain several {@link SessionResolverPlugin}s. First match wins.
 *
 * @example
 * ```ts
 * const resolver = new SessionResolverChain([
 *   new PhoneLookupResolver(async (phone) => db.userByPhone(phone)),
 *   new ThreadIdResolver(),
 * ]);
 * ```
 */
export class SessionResolverChain implements SessionResolver {
  constructor(private readonly plugins: SessionResolverPlugin[]) {
    if (plugins.length === 0) {
      throw new Error('SessionResolverChain requires at least one plugin');
    }
  }

  async resolve(
    message: InboundMessage,
  ): Promise<{ sessionId: string; userId?: string }> {
    for (const plugin of this.plugins) {
      const result = await plugin.tryResolve(message);
      if (result) return result;
    }
    throw new Error(
      `SessionResolverChain: no plugin matched message ${message.platform}:${message.id} (tried ${this.plugins
        .map((p) => p.name)
        .join(', ')})`,
    );
  }
}

/** Historical default: `{platform}:{threadId}` session, sender id as userId. */
export class ThreadIdResolver implements SessionResolverPlugin {
  readonly name = 'thread-id';

  async tryResolve(
    message: InboundMessage,
  ): Promise<{ sessionId: string; userId?: string }> {
    return {
      sessionId: `${message.platform}:${message.threadId}`,
      userId: message.from.id,
    };
  }
}

/**
 * Phone-number → user-id lookup plugin.
 *
 * Defers when:
 * - `message.from.phone` is undefined, OR
 * - the supplied `lookup` function returns `null` / `undefined` (user unknown).
 *
 * When the lookup succeeds, the returned `userId` doubles as the session id
 * so cross-channel continuity (WhatsApp + SMS + voice) converges on a single
 * Kuralle session per human.
 */
export class PhoneLookupResolver implements SessionResolverPlugin {
  readonly name = 'phone-lookup';

  constructor(
    private readonly lookup: (phone: string) => Promise<string | null | undefined>,
  ) {}

  async tryResolve(
    message: InboundMessage,
  ): Promise<{ sessionId: string; userId?: string } | undefined> {
    const phone = message.from.phone;
    if (!phone) return undefined;
    const userId = await this.lookup(phone);
    if (!userId) return undefined;
    return { sessionId: userId, userId };
  }
}
