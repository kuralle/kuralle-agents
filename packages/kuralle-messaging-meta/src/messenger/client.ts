/**
 * @module messenger/client
 *
 * Facebook Messenger Platform client.
 *
 * Extends {@link BaseMetaClient} so the webhook verification, payload
 * normalization, handler dispatch, and `/webhook` Hono sub-app are all
 * inherited. Only Messenger-specific send paths and inbound normalization
 * live in this file.
 *
 * @example
 * ```ts
 * import { createMessengerClient } from '@kuralle-agents/messaging-meta/messenger';
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
 */

import {
  MessagingError,
  type FormatConverter,
  type InboundMessage,
  type InteractiveMessage,
  type MediaCache,
  type MediaDownload,
  type MediaHandle,
  type MediaPayload,
  type MediaReference,
  type MediaStrategy,
  type ReactionData,
  type SendResult,
  type StatusUpdate,
  type MediaUploadOptions,
  FileHashDedupStrategy,
  UploadStrategy,
} from '@kuralle-agents/messaging';

import { BaseMetaClient } from '../base-client.js';
import type { BaseMetaClientConfig } from '../base-client.js';
import { GraphAPIClient } from '../graph-api/client.js';
import type {
  NormalizedMessage,
  NormalizedReaction,
  NormalizedStatus,
} from '../webhook/normalizer.js';

import type {
  MessengerClientConfig,
  MessengerSendResponse,
  ButtonTemplate,
  GenericTemplate,
  QuickReply,
  UserProfile,
  PersonaConfig,
  PersonaInfo,
  SenderAction,
} from './types.js';

import { MessengerFormatConverter } from './format.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum text message length for the Messenger Platform. */
const MESSENGER_TEXT_LIMIT = 2000;

// ---------------------------------------------------------------------------
// Raw Messenger types for PlatformClient generics
// ---------------------------------------------------------------------------

type MessengerInbound = NormalizedMessage;
type MessengerOutbound = Record<string, unknown>;

/** Internal config — the base's common fields threaded through MessengerClientConfig. */
type InternalMessengerConfig = MessengerClientConfig & BaseMetaClientConfig;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new {@link MessengerClient} instance.
 */
export function createMessengerClient(config: MessengerClientConfig): MessengerClient {
  return new MessengerClient(config);
}

// ---------------------------------------------------------------------------
// MessengerClient
// ---------------------------------------------------------------------------

/**
 * Full-featured Facebook Messenger Platform client.
 *
 * Implements the `PlatformClient` interface via {@link BaseMetaClient} and
 * layers Messenger-specific capabilities (button templates, generic
 * templates, quick replies, personas, user profiles) on top.
 */
export class MessengerClient extends BaseMetaClient<
  MessengerInbound,
  MessengerOutbound,
  InternalMessengerConfig
> {
  readonly platform = 'messenger' as const;

  private readonly config: InternalMessengerConfig;
  private readonly formatConverterInstance: MessengerFormatConverter;
  private readonly mediaCache?: MediaCache;
  private readonly mediaStrategy: MediaStrategy;

  constructor(config: MessengerClientConfig) {
    const full: InternalMessengerConfig = config as InternalMessengerConfig;
    const graphApi = new GraphAPIClient({
      accessToken: config.pageAccessToken,
      appSecret: config.appSecret,
      apiVersion: config.apiVersion,
      baseUrl: config.baseUrl,
      retry: config.retry,
      rateLimiter: config.rateLimiter,
      platform: 'messenger',
      logger: config.logger,
    });
    super(full, graphApi);
    this.config = full;
    this.formatConverterInstance = new MessengerFormatConverter();
    this.mediaCache = config.mediaCache;
    this.mediaStrategy = new FileHashDedupStrategy(
      new UploadStrategy((file, opts) => this.uploadMedia(file, opts)),
    );
  }

  /** Messenger-specific format converter. */
  get formatConverter(): FormatConverter {
    return this.formatConverterInstance;
  }

  // =========================================================================
  // Outbound — core PlatformClient methods
  // =========================================================================

  async sendText(to: string, text: string): Promise<SendResult> {
    const truncated =
      text.length > MESSENGER_TEXT_LIMIT ? text.slice(0, MESSENGER_TEXT_LIMIT) : text;

    const response = await this.graphApi.post<MessengerSendResponse>(
      `${this.config.pageId}/messages`,
      {
        recipient: { id: to },
        messaging_type: 'RESPONSE',
        message: { text: truncated },
      },
    );

    return this.toSendResult(to, response);
  }

  /**
   * Send a media message (image, video, audio, or file).
   *
   * Uses a {@link MediaStrategy} under the hood so duplicate uploads of the
   * same content are deduplicated by SHA-256 content hash (C-13.7).
   */
  async sendMedia(to: string, media: MediaPayload): Promise<SendResult> {
    const attachmentType = this.resolveAttachmentType(media.mimeType);

    // Normalize streams to Buffer so the dedup strategy can hash them.
    const normalized: MediaPayload =
      typeof media.data === 'string' || Buffer.isBuffer(media.data)
        ? media
        : { ...media, data: await streamToBuffer(media.data) };

    const resolved = await this.mediaStrategy.resolve(normalized);

    const payload =
      resolved.kind === 'url'
        ? { type: attachmentType, payload: { url: resolved.url, is_reusable: true } }
        : { type: attachmentType, payload: { attachment_id: resolved.handle.mediaId } };

    const response = await this.graphApi.post<MessengerSendResponse>(
      `${this.config.pageId}/messages`,
      {
        recipient: { id: to },
        messaging_type: 'RESPONSE',
        message: { attachment: payload },
      },
    );

    return this.toSendResult(to, response);
  }

  async sendInteractive(to: string, msg: InteractiveMessage): Promise<SendResult> {
    if (msg.action.type === 'buttons') {
      return this.sendButtonTemplate(to, {
        text: msg.body,
        buttons: msg.action.buttons.map((b) => ({
          type: 'postback' as const,
          title: b.title,
          payload: b.id,
        })),
      });
    }

    if (msg.action.type === 'list') {
      const elements = msg.action.sections.flatMap((section) =>
        section.rows.map((row) => ({
          title: row.title,
          subtitle: row.description,
          buttons: [
            {
              type: 'postback' as const,
              title: row.title.slice(0, 20),
              payload: row.id,
            },
          ],
        })),
      );

      return this.sendGenericTemplate(to, { elements: elements.slice(0, 10) });
    }

    throw new MessagingError(
      `Unsupported interactive type: ${(msg.action as { type: string }).type}`,
      'UNSUPPORTED_TYPE',
      'messenger',
    );
  }

  async sendRaw(to: string, payload: MessengerOutbound): Promise<SendResult> {
    const response = await this.graphApi.post<MessengerSendResponse>(
      `${this.config.pageId}/messages`,
      {
        recipient: { id: to },
        messaging_type: 'RESPONSE',
        ...payload,
      },
    );

    return this.toSendResult(to, response);
  }

  async markAsRead(recipientId: string): Promise<void> {
    /**
     * Messenger/Instagram `mark_seen` targets the conversation partner (PSID),
     * not a message id. Pass the user's PSID despite the PlatformClient param name.
     */
    await this.sendSenderAction(recipientId, 'mark_seen');
  }

  async sendTypingIndicator(to: string): Promise<void> {
    await this.sendSenderAction(to, 'typing_on');
  }

  // =========================================================================
  // Messenger-specific — Templates
  // =========================================================================

  async sendButtonTemplate(to: string, template: ButtonTemplate): Promise<SendResult> {
    const response = await this.graphApi.post<MessengerSendResponse>(
      `${this.config.pageId}/messages`,
      {
        recipient: { id: to },
        messaging_type: 'RESPONSE',
        message: {
          attachment: {
            type: 'template',
            payload: {
              template_type: 'button',
              text: template.text,
              buttons: template.buttons.slice(0, 3),
            },
          },
        },
      },
    );

    return this.toSendResult(to, response);
  }

  async sendGenericTemplate(to: string, template: GenericTemplate): Promise<SendResult> {
    const response = await this.graphApi.post<MessengerSendResponse>(
      `${this.config.pageId}/messages`,
      {
        recipient: { id: to },
        messaging_type: 'RESPONSE',
        message: {
          attachment: {
            type: 'template',
            payload: {
              template_type: 'generic',
              elements: template.elements.slice(0, 10),
            },
          },
        },
      },
    );

    return this.toSendResult(to, response);
  }

  async sendQuickReplies(to: string, text: string, replies: QuickReply[]): Promise<SendResult> {
    const response = await this.graphApi.post<MessengerSendResponse>(
      `${this.config.pageId}/messages`,
      {
        recipient: { id: to },
        messaging_type: 'RESPONSE',
        message: {
          text,
          quick_replies: replies.slice(0, 13),
        },
      },
    );

    return this.toSendResult(to, response);
  }

  // =========================================================================
  // Messenger-specific — Sender Actions
  // =========================================================================

  async sendSenderAction(to: string, action: SenderAction): Promise<void> {
    await this.graphApi.post(`${this.config.pageId}/messages`, {
      recipient: { id: to },
      sender_action: action,
    });
  }

  // =========================================================================
  // Messenger-specific — User Profile
  // =========================================================================

  async getUserProfile(psid: string): Promise<UserProfile> {
    return this.graphApi.get<UserProfile>(psid, {
      fields: 'first_name,last_name,profile_pic',
    });
  }

  // =========================================================================
  // Messenger-specific — Persona API
  // =========================================================================

  readonly personas = {
    create: async (config: PersonaConfig): Promise<PersonaInfo> => {
      return this.graphApi.post<PersonaInfo>(`${this.config.pageId}/personas`, config);
    },

    delete: async (personaId: string): Promise<void> => {
      await this.graphApi.delete(personaId);
    },
  };

  // =========================================================================
  // Media
  // =========================================================================

  async uploadMedia(
    file: Buffer | ReadableStream,
    options: MediaUploadOptions,
  ): Promise<MediaHandle> {
    const buffer = Buffer.isBuffer(file) ? file : await streamToBuffer(file);
    const blob = new Blob([buffer], { type: options.mimeType });
    const attachmentType = this.resolveAttachmentType(options.mimeType);

    const formData = new FormData();
    formData.append(
      'message',
      JSON.stringify({
        attachment: {
          type: attachmentType,
          payload: { is_reusable: true },
        },
      }),
    );
    formData.append('filedata', blob, options.filename ?? 'file');

    const response = await this.graphApi.postFormData<{ attachment_id: string }>(
      `${this.config.pageId}/message_attachments`,
      formData,
    );

    return { mediaId: response.attachment_id };
  }

  async downloadMedia(mediaUrl: string): Promise<MediaDownload> {
    if (this.mediaCache) {
      return this.mediaCache.getOrDownload(mediaUrl, async () => {
        const data = await this.graphApi.fetchBinary(mediaUrl);
        const mimeType = inferMimeType(mediaUrl);
        return { data, mimeType };
      });
    }
    const data = await this.graphApi.fetchBinary(mediaUrl);
    const mimeType = inferMimeType(mediaUrl);
    return { data, mimeType };
  }

  // =========================================================================
  // Template-method hooks — called by BaseMetaClient during webhook dispatch
  // =========================================================================

  protected toInboundMessage(msg: NormalizedMessage): InboundMessage {
    const threadId = `messenger:${this.config.pageId}:${msg.from}`;

    return {
      id: msg.id,
      platform: 'messenger',
      threadId,
      customerId: msg.from,
      from: { id: msg.from, name: msg.contactName },
      timestamp: new Date(parseInt(msg.timestamp, 10) * 1000),
      type: this.mapMessageType(msg.type),
      text: msg.text?.body ?? this.extractTextFallback(msg),
      media: this.extractMedia(msg),
      location: msg.location,
      interactive: msg.interactive
        ? {
            type: msg.interactive.type,
            id:
              msg.interactive.button_reply?.id ??
              msg.interactive.list_reply?.id ??
              '',
            title:
              msg.interactive.button_reply?.title ??
              msg.interactive.list_reply?.title,
            description: msg.interactive.list_reply?.description,
          }
        : undefined,
      context: msg.context
        ? { messageId: msg.context.message_id, from: msg.context.from }
        : undefined,
      raw: msg,
    };
  }

  protected toStatusUpdate(status: NormalizedStatus): StatusUpdate {
    return {
      messageId: status.id,
      status: status.status as StatusUpdate['status'],
      timestamp: new Date(parseInt(status.timestamp, 10) * 1000),
      recipientId: status.recipientId,
      threadId: `messenger:${status.phoneNumberId}:${status.recipientId}`,
      raw: status,
    };
  }

  protected toReactionData(reaction: NormalizedReaction): ReactionData {
    return {
      messageId: reaction.messageId,
      emoji: reaction.emoji,
      action: reaction.emoji ? 'react' : 'unreact',
      userId: reaction.from,
    };
  }

  // =========================================================================
  // Private — conversion helpers
  // =========================================================================

  private toSendResult(to: string, response: MessengerSendResponse): SendResult {
    return {
      messageId: response.message_id ?? '',
      threadId: `messenger:${this.config.pageId}:${to}`,
      timestamp: new Date(),
      raw: response,
    };
  }

  private mapMessageType(type: string): InboundMessage['type'] {
    const typeMap: Record<string, InboundMessage['type']> = {
      text: 'text',
      image: 'image',
      video: 'video',
      audio: 'audio',
      file: 'document',
      document: 'document',
      sticker: 'sticker',
      location: 'location',
      postback: 'interactive',
      interactive: 'interactive',
      attachment: 'unknown',
    };
    return typeMap[type] ?? 'unknown';
  }

  private extractTextFallback(msg: NormalizedMessage): string | undefined {
    if (msg.image?.caption) return msg.image.caption;
    if (msg.video?.caption) return msg.video.caption;
    if (msg.document?.caption) return msg.document.caption;
    if (msg.button) return msg.button.text;
    if (msg.interactive?.button_reply) return msg.interactive.button_reply.title;
    if (msg.interactive?.list_reply) return msg.interactive.list_reply.title;
    if (msg.location) {
      return msg.location.name ?? `${msg.location.latitude},${msg.location.longitude}`;
    }
    return undefined;
  }

  private extractMedia(msg: NormalizedMessage): MediaReference | undefined {
    const mediaTypes = ['image', 'video', 'audio', 'document', 'sticker'] as const;

    for (const type of mediaTypes) {
      const media = msg[type];
      if (media && ('id' in media || 'url' in media)) {
        return {
          id: 'id' in media ? (media.id as string) : '',
          mimeType: 'mime_type' in media ? (media.mime_type as string) : undefined,
          url: 'url' in media ? (media.url as string) : undefined,
          caption: 'caption' in media ? (media.caption as string) : undefined,
          filename: 'filename' in media ? (media.filename as string) : undefined,
        };
      }
    }

    return undefined;
  }

  private resolveAttachmentType(mimeType: string): string {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'file';
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

async function streamToBuffer(stream: ReadableStream): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  return Buffer.concat(chunks);
}

function inferMimeType(url: string): string {
  const extMatch = url.match(/\.(\w+)(?:\?|$)/);
  if (!extMatch) return 'application/octet-stream';

  const ext = extMatch[1].toLowerCase();
  const mimeMap: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    wav: 'audio/wav',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };

  return mimeMap[ext] ?? 'application/octet-stream';
}
