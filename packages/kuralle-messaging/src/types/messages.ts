/**
 * @module types/messages
 *
 * Normalized inbound messages, media, interactive replies, contact/location,
 * reactions, and status updates. One domain per file per Phase 3B.
 */

// ====================================
// CONTACT & LOCATION
// ====================================

/** Contact information normalized across platforms. */
export interface ContactInfo {
  /** Platform-specific contact identifier. */
  id: string;
  /** Display name of the contact. */
  name?: string;
  /** Phone number in E.164 format (if available). */
  phone?: string;
}

/** Geographic location data. */
export interface LocationData {
  /** Latitude in decimal degrees. */
  latitude: number;
  /** Longitude in decimal degrees. */
  longitude: number;
  /** Human-readable location name. */
  name?: string;
  /** Street address or description. */
  address?: string;
}

// ====================================
// MEDIA
// ====================================

/** A media payload to send to a platform. */
export interface MediaPayload {
  /** Media type category. */
  type: 'image' | 'video' | 'audio' | 'document' | 'sticker';
  /** The media content: a Buffer, ReadableStream, or a URL string. */
  data: Buffer | ReadableStream | string;
  /** MIME type of the media (e.g. "image/jpeg"). */
  mimeType: string;
  /** Optional filename for the media. */
  filename?: string;
  /** Optional caption to display alongside the media. */
  caption?: string;
}

/** A reference to media already hosted on a platform. */
export interface MediaReference {
  /** Platform-specific media identifier. */
  id: string;
  /** MIME type of the referenced media. */
  mimeType?: string;
  /** Public or temporary URL to access the media. */
  url?: string;
  /** Caption associated with the media. */
  caption?: string;
  /** Original filename. */
  filename?: string;
}

/** Handle returned after uploading media to a platform. */
export interface MediaHandle {
  /** Platform-assigned media identifier. */
  mediaId: string;
  /** URL where the media can be accessed (if available). */
  url?: string;
}

/** Downloaded media content. */
export interface MediaDownload {
  /** Raw media bytes. */
  data: Buffer;
  /** MIME type of the downloaded media. */
  mimeType: string;
  /** Original filename (if available). */
  filename?: string;
}

/** Options for uploading media. */
export interface MediaUploadOptions {
  /** MIME type of the media being uploaded. */
  mimeType: string;
  /** Filename for the uploaded media. */
  filename?: string;
}

// ====================================
// INTERACTIVE MESSAGES
// ====================================

/** An interactive message with buttons, a list, or a platform-specific flow. */
export interface InteractiveMessage {
  /** Type of interactive element. */
  type: 'buttons' | 'list' | 'flow';
  /** Header text or media for the interactive message. */
  header?: { type: 'text' | 'image' | 'video' | 'document'; content: string };
  /** Body text of the interactive message. */
  body: string;
  /** Footer text. */
  footer?: string;
  /** Action payload — shape depends on `type`. */
  action: InteractiveAction;
}

/** Action configuration for interactive messages. */
export type InteractiveAction =
  | { type: 'buttons'; buttons: Array<{ id: string; title: string }> }
  | { type: 'list'; button: string; sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }> }
  | { type: 'flow'; flowId: string; flowToken?: string; parameters?: Record<string, unknown> };

/** A user's reply to an interactive message. */
export interface InteractiveReply {
  /** Type of interactive element that was replied to. */
  type: string;
  /** Identifier of the selected option. */
  id: string;
  /** Display title of the selected option. */
  title?: string;
  /** Description of the selected option. */
  description?: string;
  /** Raw payload from the platform. */
  payload?: string;
  /** Parsed Flow submission (`nfm_reply.response_json`). */
  formResponse?: Record<string, unknown>;
}

// ====================================
// REACTIONS
// ====================================

/** A reaction event on a message. */
export interface ReactionData {
  /** The message that was reacted to. */
  messageId: string;
  /** The emoji used in the reaction. */
  emoji: string;
  /** Whether this is a new reaction or an unreaction. */
  action: 'react' | 'unreact';
  /** The user who reacted. */
  userId: string;
}

// ====================================
// MESSAGE CONTEXT & CONVERSATION
// ====================================

/** Context linking a message to a previous message (e.g. reply-to). */
export interface MessageContext {
  /** The message being replied to or referenced. */
  messageId: string;
  /** The sender of the referenced message. */
  from?: string;
}

/** Information about the conversation window. */
export interface ConversationInfo {
  /** Platform-specific conversation identifier. */
  id: string;
  /** When the current messaging window expires. */
  expirationTimestamp?: Date;
  /** Origin of the conversation (e.g. "user_initiated", "business_initiated"). */
  origin?: string;
}

/** Pricing information from the platform. */
export interface PricingInfo {
  /** Pricing model identifier. */
  model: string;
  /** Message category for billing purposes. */
  category: string;
}

/** Error details from a status webhook. */
export interface StatusError {
  /** Platform-specific error code. */
  code: string;
  /** Short error title. */
  title?: string;
  /** Detailed error message. */
  message?: string;
}

// ====================================
// INBOUND MESSAGE
// ====================================

/** A normalized inbound message from any messaging platform. */
export interface InboundMessage {
  /** Platform-specific message identifier. */
  id: string;
  /** The platform this message came from (e.g. "whatsapp", "messenger"). */
  platform: string;
  /** Conversation or thread identifier. */
  threadId: string;
  /** Platform-scoped customer identity (e.g. WhatsApp wa_id), distinct from session/thread. */
  customerId: string;
  /** Sender information. */
  from: ContactInfo;
  /** When the message was sent. */
  timestamp: Date;
  /** The type of content in the message. */
  type: 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'location' | 'contacts' | 'interactive' | 'reaction' | 'unknown';
  /** Text content (for text messages). */
  text?: string;
  /** Media reference (for media messages). */
  media?: MediaReference;
  /** Location data (for location messages). */
  location?: LocationData;
  /** Contact cards (for contact messages). */
  contacts?: ContactInfo[];
  /** Interactive reply data (for interactive responses). */
  interactive?: InteractiveReply;
  /** Template quick-reply tap (top-level `button`, not `interactive.button_reply`). */
  button?: { payload: string; text: string };
  /** Reaction data (for reaction events). */
  reaction?: ReactionData;
  /** Reply context if this message is a reply. */
  context?: MessageContext;
  /** Raw platform-specific message payload. */
  raw?: unknown;
}

// ====================================
// STATUS UPDATE
// ====================================

/** A delivery or read status update from the platform. */
export interface StatusUpdate {
  /** The message this status applies to. */
  messageId: string;
  /** The delivery status. */
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'deleted' | 'warning';
  /** When this status was reported. */
  timestamp: Date;
  /** The recipient of the original message. */
  recipientId: string;
  /** Thread identifier (same format as InboundMessage.threadId). */
  threadId?: string;
  /** Error details (when status is "failed" or "warning"). */
  error?: StatusError;
  /** Conversation window information. */
  conversation?: ConversationInfo;
  /** Pricing details for the message. */
  pricing?: PricingInfo;
  /** Raw platform-specific status payload. */
  raw?: unknown;
}
