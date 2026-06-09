/**
 * @module instagram/client
 *
 * Instagram Messaging API client.
 *
 * Extends {@link BaseMetaClient} so webhook verification, payload
 * normalization, handler dispatch, and the Hono `/webhook` sub-app are
 * inherited. Only Instagram-specific outbound paths and inbound
 * normalization live here.
 *
 * Key differences from WhatsApp / Messenger:
 * - Base URL is `graph.instagram.com` by default.
 * - Media is sent by public URL (audio, image, video, file attachments).
 * - Message limit is 1000 bytes (UTF-8), not characters.
 * - Send response contains `message_id` (recipient id is implicit).
 * - Only `HUMAN_AGENT` message tag is supported (7-day window).
 * - Ice breakers replace persistent menus.
 */

import {
  MessagingError,
  type FormatConverter,
  type InboundMessage,
  type InteractiveMessage,
  type MediaDownload,
  type MediaHandle,
  type MediaPayload,
  type MediaReference,
  type MediaUploadOptions,
  type ReactionData,
  type SendResult,
  type StatusUpdate,
} from '@kuralle-agents/messaging';

import { BaseMetaClient } from '../base-client.js';
import type { BaseMetaClientConfig } from '../base-client.js';
import { GraphAPIClient } from '../graph-api/client.js';
import { ByteLimitSplitter } from '../message-splitter.js';
import type {
  NormalizedMessage,
  NormalizedReaction,
  NormalizedStatus,
} from '../webhook/normalizer.js';

import type {
  InstagramClientConfig,
  InstagramSendResponse,
  InstagramQuickReply,
  InstagramGenericTemplate,
  InstagramButtonTemplate,
  PrivateReplyOptions,
  IceBreakerConfig,
  InstagramMessageTag,
} from './types.js';

import { InstagramFormatConverter } from './format.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_MESSAGE_BYTES = 1000;
const MAX_QUICK_REPLIES = 13;

// ---------------------------------------------------------------------------
// Raw types for PlatformClient generics
// ---------------------------------------------------------------------------

type InstagramInbound = NormalizedMessage;
type InstagramOutbound = Record<string, unknown>;

/** Internal config — base-client common fields threaded through the public config. */
type InternalInstagramConfig = InstagramClientConfig & BaseMetaClientConfig;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a new {@link InstagramClient} instance. */
export function createInstagramClient(config: InstagramClientConfig): InstagramClient {
  return new InstagramClient(config);
}

// ---------------------------------------------------------------------------
// InstagramClient
// ---------------------------------------------------------------------------

export class InstagramClient extends BaseMetaClient<
  InstagramInbound,
  InstagramOutbound,
  InternalInstagramConfig
> {
  readonly platform = 'instagram' as const;

  private readonly config: InternalInstagramConfig;
  private readonly formatConverterInstance: InstagramFormatConverter;
  private readonly splitter = new ByteLimitSplitter(MAX_MESSAGE_BYTES);

  constructor(config: InstagramClientConfig) {
    const full = config as InternalInstagramConfig;
    const graphApi = new GraphAPIClient({
      accessToken: config.accessToken,
      appSecret: config.appSecret,
      apiVersion: config.apiVersion ?? 'v24.0',
      baseUrl: config.baseUrl ?? 'https://graph.instagram.com',
      retry: config.retry,
      rateLimiter: config.rateLimiter,
      platform: 'instagram',
      logger: config.logger,
    });
    super(full, graphApi);
    this.config = full;
    this.formatConverterInstance = new InstagramFormatConverter();
  }

  /** Instagram-specific format converter (plain text). */
  get formatConverter(): FormatConverter {
    return this.formatConverterInstance;
  }

  // =========================================================================
  // Outbound — core PlatformClient methods
  // =========================================================================

  /**
   * Send a text message, splitting at byte boundaries to fit the 1000-byte
   * UTF-8 limit. Long messages emit multiple underlying send calls; the
   * result of the last chunk is returned.
   */
  async sendText(to: string, text: string): Promise<SendResult> {
    const chunks = this.splitter.split(text);
    let result!: SendResult;
    for (const chunk of chunks) {
      result = await this.sendSingleText(to, chunk);
    }
    return result;
  }

  /**
   * Send a media message by URL. Instagram messaging supports audio, image,
   * video, and file attachments via `attachment.payload.url`.
   */
  async sendMedia(to: string, media: MediaPayload): Promise<SendResult> {
    if (typeof media.data !== 'string') {
      throw new MessagingError(
        'Instagram messaging sends media by public URL — pass media.data as a URL string.',
        'unsupported',
        'instagram',
      );
    }

    const attachmentType = this.resolveAttachmentType(media.mimeType, media.type);

    const response = await this.graphApi.post<InstagramSendResponse>(
      `${this.config.igId}/messages`,
      {
        recipient: { id: to },
        message: {
          attachment: { type: attachmentType, payload: { url: media.data } },
        },
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
      const elements: Array<{
        title: string;
        subtitle?: string;
        buttons?: Array<{ type: 'postback'; title: string; payload: string }>;
      }> = [];

      for (const section of msg.action.sections) {
        for (const row of section.rows) {
          elements.push({
            title: row.title,
            subtitle: row.description,
            buttons: [
              {
                type: 'postback' as const,
                title: row.title.slice(0, 20),
                payload: row.id,
              },
            ],
          });
        }
      }

      return this.sendGenericTemplate(to, { elements });
    }

    throw new MessagingError(
      `Unsupported interactive type: ${(msg.action as { type: string }).type}`,
      'UNSUPPORTED_TYPE',
      'instagram',
    );
  }

  async sendRaw(to: string, payload: InstagramOutbound): Promise<SendResult> {
    const response = await this.graphApi.post<InstagramSendResponse>(
      `${this.config.igId}/messages`,
      {
        recipient: { id: to },
        ...payload,
      },
    );

    return this.toSendResult(to, response);
  }

  /**
   * Messenger/Instagram `mark_seen` targets the conversation partner (PSID),
   * not a message id. Pass the user's IGSID despite the PlatformClient param name.
   */
  async markAsRead(recipientId: string): Promise<void> {
    await this.graphApi.post(`${this.config.igId}/messages`, {
      recipient: { id: recipientId },
      sender_action: 'mark_seen',
    });
  }

  async sendTypingIndicator(to: string): Promise<void> {
    await this.graphApi.post(`${this.config.igId}/messages`, {
      recipient: { id: to },
      sender_action: 'typing_on',
    });
  }

  // =========================================================================
  // Media
  // =========================================================================

  async uploadMedia(
    _file: Buffer | ReadableStream,
    _options: MediaUploadOptions,
  ): Promise<MediaHandle> {
    throw new MessagingError(
      'Instagram messaging sends media by public URL — uploadMedia is not supported. Pass a URL via sendMedia instead.',
      'unsupported',
      'instagram',
    );
  }

  async downloadMedia(_mediaId: string): Promise<MediaDownload> {
    throw new MessagingError(
      'Instagram inbound media arrives as CDN URLs in webhooks — downloadMedia is not supported.',
      'unsupported',
      'instagram',
    );
  }

  // =========================================================================
  // Instagram-specific — Quick Replies
  // =========================================================================

  async sendQuickReplies(
    to: string,
    text: string,
    replies: InstagramQuickReply[],
  ): Promise<SendResult> {
    const response = await this.graphApi.post<InstagramSendResponse>(
      `${this.config.igId}/messages`,
      {
        recipient: { id: to },
        messaging_type: 'RESPONSE',
        message: {
          text,
          quick_replies: replies.slice(0, MAX_QUICK_REPLIES),
        },
      },
    );

    return this.toSendResult(to, response);
  }

  // =========================================================================
  // Instagram-specific — Templates
  // =========================================================================

  async sendGenericTemplate(
    to: string,
    template: InstagramGenericTemplate,
  ): Promise<SendResult> {
    const response = await this.graphApi.post<InstagramSendResponse>(
      `${this.config.igId}/messages`,
      {
        recipient: { id: to },
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

  async sendButtonTemplate(
    to: string,
    template: InstagramButtonTemplate,
  ): Promise<SendResult> {
    const response = await this.graphApi.post<InstagramSendResponse>(
      `${this.config.igId}/messages`,
      {
        recipient: { id: to },
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

  // =========================================================================
  // Instagram-specific — Private Reply
  // =========================================================================

  async sendPrivateReply(options: PrivateReplyOptions): Promise<SendResult> {
    const response = await this.graphApi.post<InstagramSendResponse>(
      `${this.config.igId}/messages`,
      {
        recipient: { comment_id: options.commentId },
        message: { text: options.text },
      },
    );

    return {
      messageId: response.message_id,
      threadId: `instagram:${this.config.igId}:comment:${options.commentId}`,
      timestamp: new Date(),
      raw: response,
    };
  }

  // =========================================================================
  // Instagram-specific — Ice Breakers
  // =========================================================================

  readonly iceBreakers = {
    set: async (breakers: IceBreakerConfig[]): Promise<void> => {
      await this.graphApi.post(`${this.config.igId}/messenger_profile`, {
        platform: 'instagram',
        ice_breakers: breakers,
      });
    },

    get: async (): Promise<IceBreakerConfig[]> => {
      const result = await this.graphApi.get<{
        data: Array<{ call_to_actions?: IceBreakerConfig['call_to_actions']; locale?: string }>;
      }>(`${this.config.igId}/messenger_profile`, { fields: 'ice_breakers' });
      const row = result.data?.[0];
      if (!row?.call_to_actions) return [];
      return [{ call_to_actions: row.call_to_actions, locale: row.locale }];
    },

    delete: async (): Promise<void> => {
      await this.graphApi.delete(`${this.config.igId}/messenger_profile`, {
        body: { fields: ['ice_breakers'] },
      });
    },
  };

  // =========================================================================
  // Instagram-specific — Message with Tag
  // =========================================================================

  async sendTextWithTag(
    to: string,
    text: string,
    tag: InstagramMessageTag,
  ): Promise<SendResult> {
    const response = await this.graphApi.post<InstagramSendResponse>(
      `${this.config.igId}/messages`,
      {
        recipient: { id: to },
        messaging_type: 'MESSAGE_TAG',
        tag,
        message: { text },
      },
    );

    return this.toSendResult(to, response);
  }

  // =========================================================================
  // Template-method hooks — called by BaseMetaClient during webhook dispatch
  // =========================================================================

  protected toInboundMessage(msg: NormalizedMessage): InboundMessage {
    const threadId = `instagram:${this.config.igId}:${msg.from}`;

    return {
      id: msg.id,
      platform: 'instagram',
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
      button: msg.button,
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
      threadId: `instagram:${this.config.igId}:${status.recipientId}`,
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

  private toSendResult(to: string, response: InstagramSendResponse): SendResult {
    return {
      messageId: response.message_id,
      threadId: `instagram:${this.config.igId}:${to}`,
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
      interactive: 'interactive',
      postback: 'interactive',
      reaction: 'reaction',
    };
    return typeMap[type] ?? 'unknown';
  }

  private extractTextFallback(msg: NormalizedMessage): string | undefined {
    if (msg.image?.caption) return msg.image.caption;
    if (msg.button) return msg.button.text;
    if (msg.interactive?.button_reply) return msg.interactive.button_reply.title;
    if (msg.interactive?.list_reply) return msg.interactive.list_reply.title;
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

  private resolveAttachmentType(
    mimeType: string,
    mediaType?: MediaPayload['type'],
  ): 'audio' | 'video' | 'file' | 'image' {
    if (mediaType === 'document') return 'file';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'file';
  }

  private async sendSingleText(to: string, text: string): Promise<SendResult> {
    const response = await this.graphApi.post<InstagramSendResponse>(
      `${this.config.igId}/messages`,
      {
        recipient: { id: to },
        message: { text },
      },
    );

    return this.toSendResult(to, response);
  }
}
