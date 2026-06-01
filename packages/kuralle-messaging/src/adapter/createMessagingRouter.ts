import { Hono } from 'hono';
import type { MessagingRouterConfig, ErrorContext } from '../types.js';
import type { OutboundMiddleware } from '../types/outbound.js';
import { MessageDeduplicator } from '../shared/deduplicator.js';
import { InMemoryWindowStore } from './window-store.js';
import { defaultSessionResolver } from './session-resolver.js';
import { StreamMapper } from './stream-mapper.js';
import { OutboundPipeline } from './outbound-pipeline.js';
import { windowGuard } from './middleware/window-guard.js';

function buildOutboundChain(extra?: OutboundMiddleware[]): OutboundMiddleware[] {
  return [...(extra ?? []), windowGuard];
}

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
 * 3. The stream mapper sends the response back through the outbound pipeline
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
  const windowStore = config.windowStore ?? new InMemoryWindowStore();
  const sessionResolver = config.sessionResolver ?? defaultSessionResolver;
  const streamMapper = new StreamMapper();

  const fallbackMessage =
    config.fallbackMessage ?? "Sorry, I'm having trouble right now. Please try again.";

  for (const [name, platform] of Object.entries(config.platforms)) {
    const pipeline = new OutboundPipeline(buildOutboundChain(config.outbound), platform);

    platform.onMessage(async (message) => {
      if (deduplicator.isDuplicate(message.id)) return;

      await windowStore.recordInbound(message.threadId, message.timestamp);

      const { sessionId, userId } = await sessionResolver.resolve(message);

      const input = message.text ?? `[${message.type}]`;

      try {
        const handle = config.runtime.run({
          input,
          sessionId,
          userId,
        });

        await streamMapper.mapStream(handle.events, platform, message.threadId, {
          responseMapper: config.responseMapper,
          pipeline,
          windowStore,
          sessionId,
          userId,
        });
      } catch (error) {
        try {
          const window = await windowStore.get(message.threadId);
          await pipeline.send({
            threadId: message.threadId,
            platform: name,
            payload: { kind: 'text', text: fallbackMessage },
            meta: { window, parts: [], sessionId, userId },
          });
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

    platform.onStatus(async (status) => {
      if (status.conversation?.expirationTimestamp && status.threadId) {
        await windowStore.recordExpiry(
          status.threadId,
          status.conversation.expirationTimestamp,
        );
      }

      config.onStatus?.(status);
    });

    app.get(`/${name}/webhook`, async (c) => {
      return platform.handleWebhook(c.req.raw);
    });

    app.post(`/${name}/webhook`, async (c) => {
      return platform.handleWebhook(c.req.raw);
    });
  }

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
