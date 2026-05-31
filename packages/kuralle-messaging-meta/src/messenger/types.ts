/**
 * @module messenger/types
 *
 * Comprehensive TypeScript types for Meta's Messenger Platform Send API.
 *
 * These types cover configuration, message payloads (text, media, templates,
 * quick replies), persona management, user profiles, and API response shapes.
 */

import type { MediaCache } from '@kuralle-agents/messaging';
import type { Logger } from '../graph-api/client.js';
import type { RetryConfig, RateLimiterConfig } from '@kuralle-agents/http-client';

// ====================================
// CONFIGURATION
// ====================================

/**
 * Configuration for creating a {@link MessengerClient}.
 *
 * The `pageAccessToken` is obtained from the Meta Developer Dashboard for
 * the Facebook Page. The `appSecret` is used for webhook signature
 * verification and `verifyToken` is the custom string set when configuring
 * the webhook subscription.
 */
export interface MessengerClientConfig {
  /** Page access token for the Messenger Platform Send API. */
  pageAccessToken: string;
  /** App secret for webhook signature verification. */
  appSecret: string;
  /** Facebook Page ID (sender identity). */
  pageId: string;
  /** Custom verify token for webhook subscription validation. */
  verifyToken: string;
  /** Graph API version (e.g. `"v24.0"`). Default `"v24.0"`. */
  apiVersion?: string;
  /** Base URL for the Graph API. Default `"https://graph.facebook.com"`. */
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
// SEND RESPONSE
// ====================================

/** Raw response from the Messenger Platform Send API. */
export interface MessengerSendResponse {
  /** The PSID of the recipient. */
  recipient_id: string;
  /** The platform-assigned message ID. */
  message_id: string;
}

// ====================================
// BUTTON TYPES
// ====================================

/**
 * A button within a Messenger template message.
 *
 * Can be either a postback button (returns a payload to the webhook) or
 * a web URL button (opens a browser).
 */
export type MessengerButton =
  | { type: 'postback'; title: string; payload: string }
  | { type: 'web_url'; title: string; url: string; webview_height_ratio?: string };

// ====================================
// TEMPLATE TYPES
// ====================================

/**
 * A button template message payload.
 *
 * Displays a text message with up to 3 buttons below it.
 */
export interface ButtonTemplate {
  /** Body text (max 640 chars). */
  text: string;
  /** Buttons to display (max 3). */
  buttons: MessengerButton[];
}

/**
 * A generic template (carousel) message payload.
 *
 * Displays a horizontally scrollable set of cards, each with an image,
 * title, subtitle, and optional buttons.
 */
export interface GenericTemplate {
  /** Carousel elements (max 10). */
  elements: GenericElement[];
}

/**
 * A single element (card) within a generic template carousel.
 */
export interface GenericElement {
  /** Card title (max 80 chars). */
  title: string;
  /** Image URL for the card. */
  image_url?: string;
  /** Card subtitle (max 80 chars). */
  subtitle?: string;
  /** Default action when the card body is tapped. */
  default_action?: DefaultAction;
  /** Buttons on the card (max 3). */
  buttons?: MessengerButton[];
}

/**
 * The default action for a generic template element.
 *
 * Defines what happens when the user taps the card body (not a button).
 */
export interface DefaultAction {
  /** Must be `"web_url"`. */
  type: 'web_url';
  /** URL to open. */
  url: string;
  /** Webview height ratio. */
  webview_height_ratio?: string;
}

// ====================================
// QUICK REPLIES
// ====================================

/**
 * A quick reply option displayed as a pill button above the composer.
 *
 * Quick replies disappear once the user taps one or types a message.
 */
export interface QuickReply {
  /** Content type of the quick reply. */
  content_type: 'text' | 'user_phone_number' | 'user_email';
  /** Display title (max 20 chars, required when `content_type` is `"text"`). */
  title?: string;
  /** Payload returned to the webhook (max 1000 chars). */
  payload?: string;
  /** Optional icon image URL (24x24 px). */
  image_url?: string;
}

// ====================================
// USER PROFILE
// ====================================

/** User profile information retrieved from the Graph API. */
export interface UserProfile {
  /** The user's PSID. */
  id: string;
  /** First name. */
  first_name?: string;
  /** Last name. */
  last_name?: string;
  /** URL of the profile picture. */
  profile_pic?: string;
}

// ====================================
// PERSONA
// ====================================

/**
 * Configuration for creating a Messenger persona.
 *
 * Personas allow the bot to respond as a named human agent with a
 * custom profile picture.
 */
export interface PersonaConfig {
  /** Display name for the persona. */
  name: string;
  /** URL of the persona's profile picture. */
  profile_picture_url: string;
}

/** Information about a created persona. */
export interface PersonaInfo {
  /** The persona ID. */
  id: string;
}

// ====================================
// MEDIA ATTACHMENT
// ====================================

/**
 * A media attachment payload for the Messenger Send API.
 *
 * Used to send images, videos, audio files, or generic files via URL.
 */
export interface MessengerMediaPayload {
  /** Media attachment type. */
  type: 'image' | 'video' | 'audio' | 'file';
  /** Attachment payload with URL or asset reference. */
  payload: {
    /** Public URL of the media file. */
    url?: string;
    /** Whether the attachment can be reused via attachment_id. */
    is_reusable?: boolean;
  };
}

// ====================================
// SENDER ACTION
// ====================================

/**
 * Valid sender action values for the Messenger Platform.
 *
 * Sender actions are sent as separate requests (cannot be combined with
 * a `message` field).
 */
export type SenderAction = 'typing_on' | 'typing_off' | 'mark_seen';
