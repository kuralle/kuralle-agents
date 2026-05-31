/**
 * @module messenger
 *
 * Facebook Messenger Platform client for the Kuralle messaging framework.
 *
 * This module provides a complete, production-ready Messenger Platform
 * integration implementing the `PlatformClient` interface from
 * `@kuralle-agents/messaging`.
 *
 * @example
 * ```ts
 * import {
 *   createMessengerClient,
 *   MessengerFormatConverter,
 * } from '@kuralle-agents/messaging-meta/messenger';
 *
 * const client = createMessengerClient({
 *   pageAccessToken: process.env.MESSENGER_PAGE_ACCESS_TOKEN!,
 *   appSecret: process.env.META_APP_SECRET!,
 *   pageId: process.env.MESSENGER_PAGE_ID!,
 *   verifyToken: process.env.MESSENGER_VERIFY_TOKEN!,
 * });
 *
 * client.onMessage(async (msg) => {
 *   await client.sendText(msg.from.id, `Echo: ${msg.text}`);
 * });
 * ```
 *
 * @packageDocumentation
 */

// ─── Client ───────────────────────────────────────────────────────────────
export { MessengerClient, createMessengerClient } from './client.js';

// ─── Types ────────────────────────────────────────────────────────────────
export type {
  MessengerClientConfig,
  MessengerSendResponse,
  MessengerButton,
  ButtonTemplate,
  GenericTemplate,
  GenericElement,
  DefaultAction,
  QuickReply,
  UserProfile,
  PersonaConfig,
  PersonaInfo,
  MessengerMediaPayload,
  SenderAction,
} from './types.js';

// ─── Format converter ────────────────────────────────────────────────────
export { MessengerFormatConverter } from './format.js';
