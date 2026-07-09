/**
 * @module webhook/normalizer
 *
 * Normalize raw Meta webhook payloads into a flat, platform-agnostic shape.
 *
 * Meta delivers webhooks with a deeply nested structure that varies between
 * WhatsApp Business, Messenger, and Instagram. This module flattens the
 * nesting into three simple arrays — `messages`, `statuses`, and `reactions`
 * — so downstream consumers can process events uniformly regardless of the
 * originating platform.
 *
 * Inspired by the normalization approach used by Kapso and other Meta SDK
 * wrappers.
 */

// ---------------------------------------------------------------------------
// Normalized event types
// ---------------------------------------------------------------------------

/** Aggregated result of normalizing a single webhook delivery. */
export interface NormalizedWebhookEvents {
  /** Inbound messages from users. */
  messages: NormalizedMessage[];
  /** Delivery / read / failure status updates. */
  statuses: NormalizedStatus[];
  /** Emoji reactions on existing messages. */
  reactions: NormalizedReaction[];
  /** Account-level webhook errors (WhatsApp `value.errors`). */
  errors: NormalizedWebhookError[];
}

/** Account-level error from a Meta webhook payload. */
export interface NormalizedWebhookError {
  code: number;
  title?: string;
  message?: string;
  error_data?: { details?: string };
  href?: string;
  phoneNumberId?: string;
}

/** A single inbound message extracted from the webhook payload. */
export interface NormalizedMessage {
  /** Platform message ID. */
  id: string;
  /** Sender identifier (phone number for WhatsApp, PSID for Messenger/Instagram). */
  from: string;
  /** Unix timestamp (seconds) as a string. */
  timestamp: string;
  /** Message type (e.g. `"text"`, `"image"`, `"interactive"`, `"postback"`). */
  type: string;
  /** Phone number ID or page ID that received the message. */
  phoneNumberId: string;
  /** Display name of the contact, when available. */
  contactName?: string;

  // --- Payload by type ---
  text?: { body: string };
  image?: { id: string; caption?: string; mime_type?: string };
  video?: { id: string; caption?: string; mime_type?: string };
  audio?: { id: string; mime_type?: string };
  document?: { id: string; filename?: string; caption?: string; mime_type?: string };
  sticker?: { id: string; mime_type?: string };
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: unknown[];
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
    nfm_reply?: { name?: string; response_json: string; body?: string };
  };
  button?: { text: string; payload: string };
  /** Order placed from a catalog, single-, or multi-product message. */
  order?: {
    catalog_id: string;
    text?: string;
    product_items: Array<{
      product_retailer_id: string;
      quantity: number;
      item_price: number;
      currency: string;
    }>;
  };
  /** Quoted/replied-to message context (normalized: WhatsApp's raw `context.id` maps to `message_id`). */
  context?: {
    message_id: string;
    from?: string;
    /** Set when the message was forwarded (WhatsApp). */
    forwarded?: boolean;
    /** Set when forwarded many times (WhatsApp). */
    frequently_forwarded?: boolean;
    /** Catalog product the user is asking about (WhatsApp product inquiry). */
    referred_product?: { catalog_id: string; product_retailer_id: string };
  };
  /** Reaction (only set for WhatsApp reaction messages before they're split out). */
  reaction?: { message_id: string; emoji: string };
  /** Click-to-WhatsApp ad referral data. */
  referral?: WhatsAppReferral;
}

/** Click-to-WhatsApp ad referral object from WhatsApp webhooks. */
export interface WhatsAppReferral {
  source_url?: string;
  source_id?: string;
  source_type?: string;
  body?: string;
  headline?: string;
  media_type?: string;
  image_url?: string;
  video_url?: string;
  thumbnail_url?: string;
  ctwa_clid?: string;
  welcome_message?: { text?: string };
}

/** A delivery status update. */
export interface NormalizedStatus {
  /** Message ID this status refers to. */
  id: string;
  /** Recipient identifier. */
  recipientId: string;
  /** Status value (`played` is WhatsApp voice-note playback). */
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'played' | (string & {});
  /** Unix timestamp (seconds) as a string. */
  timestamp: string;
  /** Phone number ID or page ID that sent the original message. */
  phoneNumberId: string;
  /** Recipient type (WhatsApp). */
  recipient_type?: string;
  /** Opaque callback data echoed from the send request (WhatsApp). */
  biz_opaque_callback_data?: string;
  /** Conversation metadata (WhatsApp-specific). */
  conversation?: {
    id: string;
    expiration_timestamp?: string;
    origin?: { type: string };
  };
  /** Pricing information (WhatsApp-specific). */
  pricing?: {
    billable: boolean;
    pricing_model: string;
    category: string | (string & {});
    type?: 'regular' | 'free_customer_service' | 'free_entry_point' | (string & {});
  };
  /** Error details when `status === "failed"`. */
  errors?: Array<{
    code: number;
    title?: string;
    message?: string;
    error_data?: { details?: string };
    href?: string;
  }>;
}

/** An emoji reaction on an existing message. */
export interface NormalizedReaction {
  /** ID of the message that was reacted to. */
  messageId: string;
  /** Sender of the reaction. */
  from: string;
  /** Emoji used in the reaction (empty string means reaction was removed). */
  emoji: string;
  /** Phone number ID or page ID that received the reaction. */
  phoneNumberId: string;
  /** Unix timestamp (seconds) as a string. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Internal raw payload shapes (minimal typing for safe traversal)
// ---------------------------------------------------------------------------

interface RawPayload {
  object?: string;
  entry?: RawEntry[];
}

interface RawEntry {
  id?: string;
  changes?: RawChange[];
  messaging?: RawMessagingEvent[];
}

interface RawChange {
  field?: string;
  value?: RawChangeValue;
}

interface RawChangeValue {
  messaging_product?: string;
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: RawWhatsAppMessage[];
  statuses?: RawWhatsAppStatus[];
  errors?: Array<Record<string, unknown>>;
}

interface RawWhatsAppMessage {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: Record<string, unknown>;
  video?: Record<string, unknown>;
  audio?: Record<string, unknown>;
  document?: Record<string, unknown>;
  sticker?: Record<string, unknown>;
  location?: Record<string, unknown>;
  contacts?: unknown[];
  interactive?: Record<string, unknown>;
  button?: Record<string, unknown>;
  order?: Record<string, unknown>;
  context?: {
    id?: string;
    from?: string;
    forwarded?: boolean;
    frequently_forwarded?: boolean;
    referred_product?: { catalog_id?: string; product_retailer_id?: string };
  };
  reaction?: { message_id?: string; emoji?: string };
  referral?: unknown;
}

interface RawWhatsAppStatus {
  id?: string;
  recipient_id?: string;
  recipient_type?: string;
  biz_opaque_callback_data?: string;
  status?: string;
  timestamp?: string;
  conversation?: Record<string, unknown>;
  pricing?: Record<string, unknown>;
  errors?: Array<Record<string, unknown>>;
}

interface RawMessagingEvent {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    attachments?: Array<{ type?: string; payload?: Record<string, unknown> }>;
    is_echo?: boolean;
    reply_to?: { mid?: string };
    quick_reply?: { payload?: string };
  };
  postback?: { title?: string; payload?: string; mid?: string };
  reaction?: { reaction?: string; emoji?: string; action?: string; mid?: string };
  delivery?: { mids?: string[]; watermark?: number };
  read?: { watermark?: number };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalize a raw Meta webhook payload into flat arrays of messages,
 * statuses, and reactions.
 *
 * Supports:
 * - **WhatsApp Business** (`object === "whatsapp_business_account"`)
 * - **Messenger / Instagram** (`object === "page"` or `object === "instagram"`)
 *
 * Unknown `object` types return empty arrays without throwing.
 *
 * @param payload - Parsed JSON body from the webhook POST request.
 * @returns Normalized events grouped by type.
 *
 * @example
 * ```ts
 * const events = normalizeWebhook(JSON.parse(rawBody));
 * for (const msg of events.messages) {
 *   console.log(`${msg.from}: ${msg.text?.body}`);
 * }
 * ```
 */
export function normalizeWebhook(payload: unknown): NormalizedWebhookEvents {
  const result: NormalizedWebhookEvents = {
    messages: [],
    statuses: [],
    reactions: [],
    errors: [],
  };

  if (!payload || typeof payload !== 'object') {
    return result;
  }

  const p = payload as RawPayload;

  if (p.object === 'whatsapp_business_account') {
    return normalizeWhatsAppWebhook(p);
  }

  if (p.object === 'page' || p.object === 'instagram') {
    return normalizePageWebhook(p);
  }

  return result;
}

// ---------------------------------------------------------------------------
// WhatsApp Business normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a WhatsApp Business Account webhook payload.
 *
 * Structure: `entry[].changes[]` where `field === "messages"`.
 * Each change's `value` contains `messages[]`, `statuses[]`, and `contacts[]`.
 */
function normalizeWhatsAppWebhook(payload: RawPayload): NormalizedWebhookEvents {
  const result: NormalizedWebhookEvents = {
    messages: [],
    statuses: [],
    reactions: [],
    errors: [],
  };

  const entries = payload.entry ?? [];

  for (const entry of entries) {
    const changes = entry.changes ?? [];

    for (const change of changes) {
      if (change.field !== 'messages') continue;

      const value = change.value;
      if (!value) continue;

      const phoneNumberId = value.metadata?.phone_number_id ?? '';

      // Build a contact-name lookup from the contacts array.
      const contactNames = new Map<string, string>();
      for (const contact of value.contacts ?? []) {
        if (contact.wa_id && contact.profile?.name) {
          contactNames.set(contact.wa_id, contact.profile.name);
        }
      }

      // --- Messages ---
      for (const msg of value.messages ?? []) {
        // Reactions are delivered as messages with type "reaction" — split them out.
        if (msg.type === 'reaction' && msg.reaction) {
          result.reactions.push({
            messageId: msg.reaction.message_id ?? '',
            from: msg.from ?? '',
            emoji: msg.reaction.emoji ?? '',
            phoneNumberId,
            timestamp: msg.timestamp ?? '',
          });
          continue;
        }

        const normalized: NormalizedMessage = {
          id: msg.id ?? '',
          from: msg.from ?? '',
          timestamp: msg.timestamp ?? '',
          type: msg.type ?? 'unknown',
          phoneNumberId,
          contactName: contactNames.get(msg.from ?? ''),
        };

        // Attach type-specific payload.
        if (msg.text) normalized.text = { body: msg.text.body ?? '' };
        if (msg.image) normalized.image = msg.image as NormalizedMessage['image'];
        if (msg.video) normalized.video = msg.video as NormalizedMessage['video'];
        if (msg.audio) normalized.audio = msg.audio as NormalizedMessage['audio'];
        if (msg.document) normalized.document = msg.document as NormalizedMessage['document'];
        if (msg.sticker) normalized.sticker = msg.sticker as NormalizedMessage['sticker'];
        if (msg.location) normalized.location = msg.location as NormalizedMessage['location'];
        if (msg.contacts) normalized.contacts = msg.contacts;
        if (msg.interactive) normalized.interactive = msg.interactive as NormalizedMessage['interactive'];
        if (msg.button) normalized.button = msg.button as NormalizedMessage['button'];
        if (msg.order) normalized.order = msg.order as NormalizedMessage['order'];
        if (msg.context) {
          // Real WhatsApp webhooks send `context.{id, from}` (plus forwarding
          // flags / referred_product) — normalize raw `id` to `message_id`.
          const referred = msg.context.referred_product;
          normalized.context = {
            message_id: msg.context.id ?? '',
            from: msg.context.from,
            forwarded: msg.context.forwarded,
            frequently_forwarded: msg.context.frequently_forwarded,
            referred_product:
              referred?.catalog_id && referred.product_retailer_id
                ? {
                    catalog_id: referred.catalog_id,
                    product_retailer_id: referred.product_retailer_id,
                  }
                : undefined,
          };
        }
        if (msg.referral) normalized.referral = msg.referral as WhatsAppReferral;

        result.messages.push(normalized);
      }

      for (const err of value.errors ?? []) {
        result.errors.push(normalizeWebhookError(err, phoneNumberId));
      }

      // --- Statuses ---
      for (const status of value.statuses ?? []) {
        const normalizedStatus: NormalizedStatus = {
          id: status.id ?? '',
          recipientId: status.recipient_id ?? '',
          status: normalizeStatusValue(status.status),
          timestamp: status.timestamp ?? '',
          phoneNumberId,
        };

        if (status.recipient_type) normalizedStatus.recipient_type = status.recipient_type;
        if (status.biz_opaque_callback_data) {
          normalizedStatus.biz_opaque_callback_data = status.biz_opaque_callback_data;
        }

        if (status.conversation) {
          normalizedStatus.conversation = status.conversation as NormalizedStatus['conversation'];
        }
        if (status.pricing) {
          normalizedStatus.pricing = status.pricing as NormalizedStatus['pricing'];
        }
        if (status.errors) {
          normalizedStatus.errors = status.errors as NormalizedStatus['errors'];
        }

        result.statuses.push(normalizedStatus);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Page / Instagram normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a Messenger or Instagram webhook payload.
 *
 * Structure: `entry[].messaging[]` where each event has `sender.id`,
 * `recipient.id`, and a timestamp.
 */
function normalizePageWebhook(payload: RawPayload): NormalizedWebhookEvents {
  const result: NormalizedWebhookEvents = {
    messages: [],
    statuses: [],
    reactions: [],
    errors: [],
  };

  const entries = payload.entry ?? [];

  for (const entry of entries) {
    const pageId = entry.id ?? '';
    const events = entry.messaging ?? [];

    for (const event of events) {
      const senderId = event.sender?.id ?? '';
      const timestamp = String(event.timestamp ?? '');

      // --- Inbound message ---
      if (event.message && !event.message.is_echo) {
        const msg = event.message;
        const normalized: NormalizedMessage = {
          id: msg.mid ?? '',
          from: senderId,
          timestamp,
          type: resolvePageMessageType(msg),
          phoneNumberId: pageId,
        };

        if (msg.text) {
          normalized.text = { body: msg.text };
        }

        // Attachments (images, video, audio, files).
        if (msg.attachments && msg.attachments.length > 0) {
          const first = msg.attachments[0]!;
          const attachType = first.type ?? 'unknown';

          if (attachType === 'image' && first.payload) {
            normalized.image = { id: '', ...first.payload } as NormalizedMessage['image'];
          } else if (attachType === 'video' && first.payload) {
            normalized.video = { id: '', ...first.payload } as NormalizedMessage['video'];
          } else if (attachType === 'audio' && first.payload) {
            normalized.audio = { id: '', ...first.payload } as NormalizedMessage['audio'];
          } else if (attachType === 'file' && first.payload) {
            normalized.document = { id: '', ...first.payload } as NormalizedMessage['document'];
          }
        }

        // Reply context.
        if (msg.reply_to?.mid) {
          normalized.context = { message_id: msg.reply_to.mid };
        }

        if (msg.quick_reply?.payload) {
          normalized.type = 'postback';
          normalized.button = {
            text: msg.text ?? '',
            payload: msg.quick_reply.payload,
          };
        }

        result.messages.push(normalized);
        continue;
      }

      // --- Postback (button tap / get-started) ---
      if (event.postback) {
        const pb = event.postback;
        result.messages.push({
          id: pb.mid ?? `postback_${timestamp}`,
          from: senderId,
          timestamp,
          type: 'postback',
          phoneNumberId: pageId,
          button: {
            text: pb.title ?? '',
            payload: pb.payload ?? '',
          },
        });
        continue;
      }

      // --- Reaction ---
      if (event.reaction) {
        const r = event.reaction;
        result.reactions.push({
          messageId: r.mid ?? '',
          from: senderId,
          emoji: r.emoji ?? r.reaction ?? '',
          phoneNumberId: pageId,
          timestamp,
        });
        continue;
      }

      // --- Delivery receipt ---
      if (event.delivery) {
        for (const mid of event.delivery.mids ?? []) {
          result.statuses.push({
            id: mid,
            recipientId: senderId,
            status: 'delivered',
            timestamp,
            phoneNumberId: pageId,
          });
        }
        continue;
      }

      // --- Read receipt ---
      if (event.read) {
        result.statuses.push({
          id: `read_${timestamp}`,
          recipientId: senderId,
          status: 'read',
          timestamp,
          phoneNumberId: pageId,
        });
        continue;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the message type for a Messenger / Instagram message. */
function resolvePageMessageType(msg: NonNullable<RawMessagingEvent['message']>): string {
  if (msg.attachments && msg.attachments.length > 0) {
    return msg.attachments[0]?.type ?? 'attachment';
  }
  if (msg.text) {
    return 'text';
  }
  return 'unknown';
}

/** Normalise a status string; unknown values pass through unchanged. */
function normalizeStatusValue(raw: string | undefined): NormalizedStatus['status'] {
  if (!raw) return 'sent';
  switch (raw) {
    case 'sent':
    case 'delivered':
    case 'read':
    case 'failed':
    case 'played':
      return raw;
    default:
      return raw;
  }
}

function normalizeWebhookError(
  err: Record<string, unknown>,
  phoneNumberId: string,
): NormalizedWebhookError {
  return {
    code: typeof err.code === 'number' ? err.code : 0,
    title: typeof err.title === 'string' ? err.title : undefined,
    message: typeof err.message === 'string' ? err.message : undefined,
    error_data:
      err.error_data && typeof err.error_data === 'object'
        ? (err.error_data as { details?: string })
        : undefined,
    href: typeof err.href === 'string' ? err.href : undefined,
    phoneNumberId,
  };
}
