/**
 * @module whatsapp/types
 *
 * Comprehensive TypeScript types mirroring Meta's WhatsApp Cloud API.
 *
 * These types cover configuration, message payloads (text, media, interactive,
 * template, location, contacts), business profile management, WhatsApp Flows,
 * and API response shapes.
 */

import type { MediaCache } from '@kuralle-agents/messaging';
import type { Logger } from '../graph-api/client.js';
import type { RetryConfig, RateLimiterConfig } from '@kuralle-agents/http-client';

// ====================================
// CONFIGURATION
// ====================================

/**
 * Configuration for creating a {@link WhatsAppClient}.
 *
 * The `accessToken` and `appSecret` are obtained from the Meta Developer
 * Dashboard. The `phoneNumberId` identifies which WhatsApp Business phone
 * number to send messages from, and `verifyToken` is the custom string
 * you set when configuring the webhook subscription.
 */
export interface WhatsAppClientConfig {
  /** Long-lived or system-user access token for the Graph API. */
  accessToken: string;
  /** App secret for webhook signature verification. */
  appSecret: string;
  /** WhatsApp Business phone number ID (sender identity). */
  phoneNumberId: string;
  /** Custom verify token for webhook subscription validation. */
  verifyToken: string;
  /** Graph API version (e.g. `"v21.0"`). Default `"v21.0"`. */
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
// THREAD ID
// ====================================

/**
 * Composite thread identifier for a WhatsApp conversation.
 *
 * Uniquely identifies a conversation between a specific WhatsApp Business
 * phone number and a user.
 */
export interface WhatsAppThreadId {
  /** The WhatsApp Business phone number ID. */
  phoneNumberId: string;
  /** The user's WhatsApp ID (E.164 phone number). */
  userWaId: string;
}

// ====================================
// SEND RESPONSE
// ====================================

/** Raw response from the WhatsApp Cloud API messages endpoint. */
export interface WhatsAppSendResponse {
  /** Always `"whatsapp"`. */
  messaging_product: 'whatsapp';
  /** Contact mapping between input numbers and WhatsApp IDs. */
  contacts: Array<{ input: string; wa_id: string }>;
  /** The sent message(s) with their platform-assigned IDs. */
  messages: Array<{ id: string }>;
}

// ====================================
// TEMPLATE TYPES
// ====================================

/**
 * A template message to send via the WhatsApp Cloud API.
 *
 * Templates must be pre-approved by Meta before they can be used.
 * They are the only message type allowed outside the 24-hour
 * customer service window.
 */
export interface TemplateMessage {
  /** The approved template name. */
  name: string;
  /** Language configuration. */
  language: TemplateLanguage;
  /** Optional template components (header, body, buttons). */
  components?: TemplateComponent[];
}

/** Language specification for a template message. */
export interface TemplateLanguage {
  /** BCP 47 language code (e.g. `"en_US"`, `"es"`). */
  code: string;
  /** Language fallback policy. Default `"deterministic"`. */
  policy?: string;
}

/** A single component within a template message. */
export interface TemplateComponent {
  /** Component type. */
  type: 'header' | 'body' | 'button';
  /** Dynamic parameters to fill into the component. */
  parameters?: TemplateParameter[];
  /** Button sub-type (e.g. `"quick_reply"`, `"url"`). Required for buttons. */
  sub_type?: string;
  /** Button index (0-based). Required for buttons. */
  index?: number;
}

/** A dynamic parameter within a template component. */
export interface TemplateParameter {
  /** The parameter data type. */
  type: 'text' | 'image' | 'video' | 'document' | 'currency' | 'date_time' | 'payload' | 'action';
  /** Text value (when `type` is `"text"`). */
  text?: string;
  /** Image media object (when `type` is `"image"`). */
  image?: MediaObject;
  /** Video media object (when `type` is `"video"`). */
  video?: MediaObject;
  /** Document media object (when `type` is `"document"`). */
  document?: MediaObject & { filename?: string };
  /** Currency value (when `type` is `"currency"`). */
  currency?: { fallback_value: string; code: string; amount_1000: number };
  /** Date/time value (when `type` is `"date_time"`). */
  date_time?: { fallback_value: string };
  /** Quick-reply button payload (when `type` is `"payload"`). */
  payload?: string;
  /** Action payload (when `type` is `"action"`). */
  action?: Record<string, unknown>;
}

// ====================================
// MEDIA OBJECT
// ====================================

/**
 * A media object used within WhatsApp messages.
 *
 * Specify either `id` (for previously uploaded media) or `link` (for
 * publicly accessible URLs). Both should not be provided simultaneously.
 */
export interface MediaObject {
  /** Media ID from a previous upload. */
  id?: string;
  /** Public URL to the media file. */
  link?: string;
  /** Caption text displayed alongside the media. */
  caption?: string;
  /** Filename for document media. */
  filename?: string;
  /** MIME type of the media. */
  mime_type?: string;
}

// ====================================
// INTERACTIVE MESSAGE TYPES
// ====================================

/**
 * A list-style interactive message with expandable sections.
 *
 * Supports up to 10 sections with up to 10 rows each. The `button` text
 * appears on the collapsed list control.
 */
export interface ListMessage {
  /** Optional header (text only for lists). */
  header?: { type: 'text'; text: string };
  /** Body text (required, max 1024 chars). */
  body: { text: string };
  /** Optional footer text (max 60 chars). */
  footer?: { text: string };
  /** Text displayed on the list expand button (max 20 chars). */
  button: string;
  /** List sections containing selectable rows. */
  sections: ListSection[];
}

/** A section within a list interactive message. */
export interface ListSection {
  /** Section title. */
  title: string;
  /** Rows within this section. */
  rows: ListRow[];
}

/** A single row within a list section. */
export interface ListRow {
  /** Unique row identifier (returned in the interactive reply). */
  id: string;
  /** Row title (max 24 chars). */
  title: string;
  /** Optional description (max 72 chars). */
  description?: string;
}

/**
 * A button-style interactive message with up to 3 reply buttons.
 *
 * Supports text, image, video, or document headers.
 */
export interface ButtonMessage {
  /** Optional header content. */
  header?:
    | { type: 'text'; text: string }
    | { type: 'image'; image: MediaObject }
    | { type: 'video'; video: MediaObject }
    | { type: 'document'; document: MediaObject };
  /** Body text (required, max 1024 chars). */
  body: { text: string };
  /** Optional footer text (max 60 chars). */
  footer?: { text: string };
  /** Reply buttons (max 3). */
  buttons: ReplyButton[];
}

/** A reply button within a button interactive message. */
export interface ReplyButton {
  /** Unique button identifier (returned in the interactive reply). */
  id: string;
  /** Button display text (max 20 chars). */
  title: string;
}

/**
 * A call-to-action URL button interactive message.
 *
 * Opens the specified URL when the user taps the button.
 */
export interface CTAButtonMessage {
  /** Optional header (text only). */
  header?: { type: 'text'; text: string };
  /** Body text (required). */
  body: { text: string };
  /** Optional footer text. */
  footer?: { text: string };
  /** Must be `"cta_url"`. */
  name: 'cta_url';
  /** URL button parameters. */
  parameters: {
    /** Text displayed on the button. */
    display_text: string;
    /** URL to open when the button is tapped. */
    url: string;
  };
}

/**
 * Input for sending a WhatsApp Flow as an interactive message.
 *
 * WhatsApp Flows are multi-screen forms that run natively within WhatsApp.
 */
export interface FlowInteractiveInput {
  /** Body text for the flow message. */
  body: { text: string };
  /** Optional footer text. */
  footer?: { text: string };
  /** The WhatsApp Flow ID. */
  flowId: string;
  /** Call-to-action button text that opens the flow. */
  flowCta: string;
  /** Unique token for this flow session. */
  flowToken: string;
  /** Flow action type. */
  flowAction: 'navigate' | 'data_exchange';
  /** Optional initial data for the flow. */
  flowActionPayload?: Record<string, unknown>;
}

// ====================================
// LOCATION & CONTACTS
// ====================================

/** A location payload for sending a map pin. */
export interface LocationPayload {
  /** Latitude in decimal degrees. */
  latitude: number;
  /** Longitude in decimal degrees. */
  longitude: number;
  /** Location name (displayed as title). */
  name?: string;
  /** Street address. */
  address?: string;
}

/** A contact card payload for sending contact information. */
export interface ContactPayload {
  /** Contact name (at least `formatted_name` is required). */
  name: { formatted_name: string; first_name?: string; last_name?: string };
  /** Phone numbers. */
  phones?: Array<{ phone: string; type?: string }>;
  /** Email addresses. */
  emails?: Array<{ email: string; type?: string }>;
}

// ====================================
// BUSINESS PROFILE
// ====================================

/** WhatsApp Business profile fields. */
export interface BusinessProfile {
  /** About text (max 139 chars). */
  about?: string;
  /** Business address. */
  address?: string;
  /** Business description (max 256 chars). */
  description?: string;
  /** Business email. */
  email?: string;
  /** Always `"whatsapp"`. */
  messaging_product?: string;
  /** URL of the profile picture. */
  profile_picture_url?: string;
  /** Business vertical/industry. */
  vertical?: string;
  /** Website URLs (max 2). */
  websites?: string[];
}

// ====================================
// TEMPLATE MANAGEMENT
// ====================================

/**
 * A template definition for creating or updating message templates
 * via the WhatsApp Business Management API.
 */
export interface TemplateDefinition {
  /** Template name (lowercase, underscores only). */
  name: string;
  /** BCP 47 language code. */
  language: string;
  /** Template category. */
  category: 'AUTHENTICATION' | 'MARKETING' | 'UTILITY';
  /** Template components (header, body, footer, buttons). */
  components: TemplateDefinitionComponent[];
  /** Whether Meta can auto-recategorize the template. */
  allow_category_change?: boolean;
}

/** A component within a template definition. */
export interface TemplateDefinitionComponent {
  /** Component type (e.g. `"HEADER"`, `"BODY"`, `"FOOTER"`, `"BUTTONS"`). */
  type: string;
  /** Text content for text-based components. */
  text?: string;
  /** Header format (`"TEXT"`, `"IMAGE"`, `"VIDEO"`, `"DOCUMENT"`). */
  format?: string;
  /** Button definitions for button components. */
  buttons?: Array<{ type: string; text?: string; url?: string; phone_number?: string }>;
  /** Example data for template approval. */
  example?: Record<string, unknown>;
  /** Additional component-specific fields. */
  [key: string]: unknown;
}

/** Information about an existing message template. */
export interface TemplateInfo {
  /** Template ID. */
  id: string;
  /** Template name. */
  name: string;
  /** BCP 47 language code. */
  language: string;
  /** Approval status (e.g. `"APPROVED"`, `"PENDING"`, `"REJECTED"`). */
  status: string;
  /** Template category. */
  category: string;
  /** Template components. */
  components: TemplateDefinitionComponent[];
  /** Quality rating (Meta `quality_score.score`), when available. */
  quality?: string;
  /** Whether the template is paused due to quality. */
  paused?: boolean;
}

// ====================================
// WHATSAPP FLOWS
// ====================================

/** Input for creating a new WhatsApp Flow. */
export interface FlowDefinition {
  /** Flow name. */
  name: string;
  /** Flow categories. */
  categories?: string[];
  /** Clone from an existing flow. */
  clone_flow_id?: string;
}

/** Information about an existing WhatsApp Flow. */
export interface FlowInfo {
  /** Flow ID. */
  id: string;
  /** Flow name. */
  name: string;
  /** Flow status (e.g. `"DRAFT"`, `"PUBLISHED"`, `"DEPRECATED"`). */
  status: string;
  /** Flow categories. */
  categories: string[];
}

/** Assets associated with a WhatsApp Flow. */
export interface FlowAssets {
  /** Array of flow asset entries. */
  data: Array<{
    /** Asset name (usually `"flow.json"`). */
    name: string;
    /** Asset type identifier. */
    asset_type: string;
    /** URL to download the asset. */
    download_url: string;
  }>;
}

// ====================================
// MEDIA RESPONSE
// ====================================

/** Response from the WhatsApp media info endpoint. */
export interface WhatsAppMediaResponse {
  /** Media ID. */
  id: string;
  /** Temporary download URL (valid for a short period). */
  url: string;
  /** MIME type of the media. */
  mime_type: string;
  /** SHA-256 hash of the media content. */
  sha256: string;
  /** File size in bytes. */
  file_size: number;
}

// ====================================
// HELPER TYPES
// ====================================

/**
 * Options for the {@link WhatsAppClient.sendTextOrTemplate} method.
 *
 * Attempts to send a free-form text message first; if the 24-hour window
 * has closed, falls back to the specified template.
 */
export interface TextOrTemplateOptions {
  /** The text message to attempt first. */
  text: string;
  /** The template to fall back to if the messaging window is closed. */
  fallbackTemplate: TemplateMessage;
}
