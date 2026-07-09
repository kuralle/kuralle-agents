/**
 * @module instagram
 *
 * Instagram Messaging API client for the Kuralle messaging framework.
 *
 * This module provides a complete, production-ready Instagram Messaging
 * integration implementing the `PlatformClient` interface from
 * `@kuralle-agents/messaging`.
 *
 * Key features:
 * - Text, image, quick reply, and template messages
 * - Generic template (carousel) and button template messages
 * - Private replies to comments on posts and reels
 * - Ice breaker management (set, get, delete)
 * - Typing indicator support
 * - Smart message splitting for the 1000-byte limit
 * - Webhook handling with HMAC-SHA256 signature verification
 *
 * @example
 * ```ts
 * import {
 *   createInstagramClient,
 *   InstagramFormatConverter,
 * } from '@kuralle-agents/messaging-meta/instagram';
 *
 * const client = createInstagramClient({
 *   accessToken: process.env.INSTAGRAM_ACCESS_TOKEN!,
 *   appSecret: process.env.META_APP_SECRET!,
 *   igId: process.env.INSTAGRAM_ACCOUNT_ID!,
 *   verifyToken: process.env.INSTAGRAM_VERIFY_TOKEN!,
 * });
 *
 * client.onMessage(async (msg) => {
 *   await client.sendText(msg.from.id, `Echo: ${msg.text}`);
 * });
 * ```
 *
 * @packageDocumentation
 */

// --- Client ---------------------------------------------------------------
export { InstagramClient, createInstagramClient } from './client.js';

// --- Types ----------------------------------------------------------------
export type {
  InstagramClientConfig,
  InstagramThreadId,
  InstagramSendResponse,
  InstagramQuickReply,
  InstagramButton,
  InstagramGenericElement,
  InstagramGenericTemplate,
  InstagramButtonTemplate,
  PrivateReplyOptions,
  IceBreaker,
  IceBreakerConfig,
  InstagramMessageTag,
} from './types.js';

// --- Format converter -----------------------------------------------------
export { InstagramFormatConverter } from './format.js';

// --- Ice breakers ---------------------------------------------------------
export {
  buildIceBreakerConfig,
  validateIceBreakers,
  MAX_ICE_BREAKERS,
} from './ice-breakers.js';
