import { Hono } from 'hono';
import type { MessagingRouterConfig, ErrorContext } from '../types.js';
import { MessageDeduplicator } from '../shared/deduplicator.js';
import { WindowTracker } from './window-tracker.js';
import { defaultSessionResolver } from './session-resolver.js';
import { StreamMapper } from './stream-mapper.js';

/**
 * Create a Hono router that bridges messaging platform webhooks with the Kuralle runtime.
 *
 * For each platform in the config, this function:
 * 1. Registers message, status, and reaction handlers on the platform client
 * 2. Mounts GET and POST webhook routes at `/{platformName}/webhook`
 *
 * When a message arrives:
 * 1. The platform client verifies the webhook signature, parses the payload,
 *    and dispatches to the registered message handler
 * 2. The handler deduplicates the message, tracks the conversation window,
 *    resolves the session, and streams the runtime response
 * 3. The stream mapper sends the response back through the platform client
 *
 * @param config - Router configuration with runtime, platforms, and optional customizations.
 * @returns A Hono app with webhook routes mounted for each platform.
 *
 * @example
 * ```typescript
 * import { createMessagingRouter } from '@kuralle-agents/messaging';
 *
 * const router = createMessagingRouter({
 *   runtime,
 *   platforms: {
 *     whatsapp: whatsappClient,
 *     messenger: messengerClient,
 *   },
 * });
 *
 * // Mount into your main Hono app
 * app.route('/messaging', router);
 * ```
 */
export function createMessagingRouter(config: MessagingRouterConfig): Hono {
  const app = new Hono();
  const deduplicator = new MessageDeduplicator();
  const windowTracker = new WindowTracker();
  const sessionResolver = config.sessionResolver ?? defaultSessionResolver;
  const streamMapper = new StreamMapper();

  const fallbackMessage =
    config.fallbackMessage ?? "Sorry, I'm having trouble right now. Please try again.";

  for (const [name, platform] of Object.entries(config.platforms)) {
    // -------------------------------------------------------
    // Register message handler
    // -------------------------------------------------------
    platform.onMessage(async (message) => {
      // Deduplicate — webhooks can be retried by the platform
      if (deduplicator.isDuplicate(message.id)) return;

      // Track the messaging window
      windowTracker.recordInbound(message.threadId, message.timestamp);

      // Resolve Kuralle session
      const { sessionId, userId } = await sessionResolver.resolve(message);

      // Extract text input — fall back to a type indicator for non-text messages
      const input = message.text ?? `[${message.type}]`;

      try {
        // Stream from the Kuralle runtime
        const handle = config.runtime.run({
          input,
          sessionId,
          userId,
        });

        // Map the stream output to platform messages
        await streamMapper.mapStream(handle.events, platform, message.threadId, {
          responseMapper: config.responseMapper,
        });
      } catch (error) {
        // Attempt to send a fallback message
        try {
          await platform.sendText(message.threadId, fallbackMessage);
        } catch {
          // Cannot even send fallback — nothing more we can do
        }

        const errorContext: ErrorContext = {
          message,
          platform: name,
          error: error as Error,
        };
        config.onError?.(error as Error, errorContext);
      }
    });

    // -------------------------------------------------------
    // Register status handler
    // -------------------------------------------------------
    platform.onStatus(async (status) => {
      // Track window expiry from platform-reported conversation info.
      // Use status.threadId (set by platform clients in the same format as
      // inbound messages) so the window tracker key matches recordInbound().
      if (status.conversation?.expirationTimestamp && status.threadId) {
        windowTracker.recordExpiry(
          status.threadId,
          status.conversation.expirationTimestamp,
        );
      }

      // Forward to user-provided status handler
      config.onStatus?.(status);
    });

    // -------------------------------------------------------
    // Mount webhook routes
    // -------------------------------------------------------
    // GET — webhook verification (e.g. Meta's hub.verify_token challenge)
    app.get(`/${name}/webhook`, async (c) => {
      return platform.handleWebhook(c.req.raw);
    });

    // POST — incoming events (messages, statuses, reactions)
    app.post(`/${name}/webhook`, async (c) => {
      return platform.handleWebhook(c.req.raw);
    });
  }

  // -------------------------------------------------------
  // /health — aggregated probe. Included when at least one
  // platform client implements the optional healthCheck().
  // -------------------------------------------------------
  const hasAnyProbe = Object.values(config.platforms).some(
    (p) => typeof p.healthCheck === 'function',
  );
  if (hasAnyProbe) {
    app.get('/health', async (c) => {
      const results: Record<string, { ok: boolean; reason?: string; details?: Record<string, unknown> }> = {};
      let allOk = true;
      for (const [name, platform] of Object.entries(config.platforms)) {
        if (typeof platform.healthCheck !== 'function') continue;
        try {
          const r = await platform.healthCheck();
          results[name] = r;
          if (!r.ok) allOk = false;
        } catch (err) {
          results[name] = { ok: false, reason: (err as Error).message };
          allOk = false;
        }
      }
      return c.json({ ok: allOk, platforms: results }, allOk ? 200 : 503);
    });
  }

  return app;
}
