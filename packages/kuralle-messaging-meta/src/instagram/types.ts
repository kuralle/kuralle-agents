/**
 * @module instagram/types
 *
 * Comprehensive TypeScript types for the Instagram Messaging API.
 *
 * These types cover configuration, message payloads (text, image, quick replies,
 * generic templates, button templates), ice breakers, private replies, and API
 * response shapes.
 *
 * Key differences from WhatsApp / Messenger:
 * - Base URL is `graph.instagram.com` (not `graph.facebook.com`).
 * - Media is sent by public URL (audio, image, video, file attachments).
 * - Message limit is 1000 bytes (UTF-8), not characters.
 * - Quick replies support text, user_phone_number, and user_email content types.
 * - Only `HUMAN_AGENT` message tag is supported (7-day window).
 * - Ice breakers replace persistent menus.
 */

import type { MediaCache } from '@kuralle-agents/messaging';
import type { Logger } from '../graph-api/client.js';
import type { RetryConfig, RateLimiterConfig } from '@kuralle-agents/http-client';

// ====================================
// CONFIGURATION
// ====================================

/**
 * Configuration for creating an {@link InstagramClient}.
 *
 * The `accessToken` is an Instagram User access token obtained via
 * the Meta Developer Dashboard. The `igId` is the Instagram professional
 * account ID (not the IGSID of a user).
 */
export interface InstagramClientConfig {
  /** Instagram User access token for the Graph API. */
  accessToken: string;
  /** App secret for webhook signature verification. */
  appSecret: string;
  /** Instagram professional account ID (sender identity). */
  igId: string;
  /** Custom verify token for webhook subscription validation. */
  verifyToken: string;
  /** Graph API version (e.g. `"v24.0"`). Default `"v24.0"`. */
  apiVersion?: string;
  /** Base URL for the Instagram Graph API. Default `"https://graph.instagram.com"`. */
  baseUrl?: string;
  /** Optional structured logger. */
  logger?: Logger;
  /** Retry behaviour configuration. */
  retry?: Partial<RetryConfig>;
  /** Rate limiter configuration. */
  rateLimiter?: Partial<RateLimiterConfig>;
  /** Optional in-memory media cache for downloaded attachments. */
  mediaCache?: MediaCache;
}

// ====================================
// THREAD ID
// ====================================

/**
 * Composite thread identifier for an Instagram conversation.
 *
 * Uniquely identifies a conversation between a specific Instagram
 * professional account and a user.
 */
export interface InstagramThreadId {
  /** The Instagram professional account ID. */
  igId: string;
  /** The Instagram-scoped user ID (IGSID). */
  igsId: string;
}

// ====================================
// SEND RESPONSE
// ====================================

/**
 * Raw response from the Instagram Messaging API messages endpoint.
 */
export interface InstagramSendResponse {
  /** Platform-assigned message identifier. */
  message_id: string;
  /** Recipient IGSID (returned by some API versions). */
  recipient_id?: string;
}

// ====================================
// QUICK REPLIES
// ====================================

/**
 * A quick reply option for Instagram messages.
 *
 * Maximum 13 quick replies per message.
 */
export interface InstagramQuickReply {
  /** Quick reply content type. */
  content_type: 'text' | 'user_phone_number' | 'user_email';
  /** Display text for text quick replies (max 20 chars). */
  title?: string;
  /** Payload string returned when the user taps this quick reply. */
  payload?: string;
}

// ====================================
// BUTTONS
// ====================================

/**
 * A button within an Instagram template message.
 *
 * Instagram supports `postback` (sends payload to webhook) and
 * `web_url` (opens a URL in the browser) button types.
 */
export interface InstagramButton {
  /** Button type. */
  type: 'postback' | 'web_url';
  /** Display text on the button. */
  title: string;
  /** Payload string (required for `postback` type). */
  payload?: string;
  /** URL to open (required for `web_url` type). */
  url?: string;
}

// ====================================
// GENERIC TEMPLATE (CAROUSEL)
// ====================================

/**
 * An element within a generic template carousel.
 *
 * Generic templates render as horizontally scrollable cards, each with
 * an optional image, title, subtitle, default tap action, and buttons.
 */
export interface InstagramGenericElement {
  /** Card title (required, max 80 chars). */
  title: string;
  /** Image URL displayed at the top of the card. */
  image_url?: string;
  /** Subtitle text below the title (max 80 chars). */
  subtitle?: string;
  /** Action triggered when the card is tapped (outside of buttons). */
  default_action?: { type: 'web_url'; url: string };
  /** Up to 3 buttons displayed at the bottom of the card. */
  buttons?: InstagramButton[];
}

/**
 * A generic template (carousel) message.
 *
 * Supports up to 10 elements displayed as horizontally scrollable cards.
 */
export interface InstagramGenericTemplate {
  /** Array of carousel card elements (max 10). */
  elements: InstagramGenericElement[];
}

// ====================================
// BUTTON TEMPLATE
// ====================================

/**
 * A button template message.
 *
 * Displays a text message with up to 3 buttons below it.
 */
export interface InstagramButtonTemplate {
  /** Body text displayed above the buttons (max 640 chars). */
  text: string;
  /** Up to 3 buttons. */
  buttons: InstagramButton[];
}

// ====================================
// PRIVATE REPLY
// ====================================

/**
 * Options for sending a private reply to an Instagram comment.
 *
 * Uses `recipient.comment_id` instead of `recipient.id` to initiate
 * a DM thread from a comment on a post or reel.
 */
export interface PrivateReplyOptions {
  /** The comment ID to reply to privately. */
  commentId: string;
  /** The text message to send as a private reply. */
  text: string;
}

// ====================================
// ICE BREAKERS
// ====================================

/**
 * A single ice breaker question-payload pair.
 *
 * Ice breakers appear as suggested conversation starters when a user
 * opens a DM thread for the first time. Tapping one sends a
 * `messaging_postback` webhook event with the specified payload.
 */
export interface IceBreaker {
  /** The question text displayed to the user. */
  question: string;
  /** Payload string sent as a postback when the user taps this ice breaker. */
  payload: string;
}

/**
 * Configuration for a set of ice breakers.
 *
 * Each config contains an array of call-to-action items and an
 * optional locale for localization.
 */
export interface IceBreakerConfig {
  /** Array of ice breaker items (max 4 per locale). */
  call_to_actions: IceBreaker[];
  /** BCP 47 locale code (e.g. `"en_US"`). Optional. */
  locale?: string;
}

// ====================================
// MESSAGE TAG
// ====================================

/**
 * Message tags supported by Instagram.
 *
 * Instagram only supports the `HUMAN_AGENT` tag, which extends
 * the messaging window to 7 days for live agent handoff scenarios.
 */
export type InstagramMessageTag = 'HUMAN_AGENT';
