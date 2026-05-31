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
 * Key quirks vs Messenger:
 * - Base URL is `graph.instagram.com` by default.
 * - Only IMAGE attachments are supported.
 * - Send API caps at 1000 UTF-8 bytes per message — long text is split
 *   via the shared {@link ByteLimitSplitter} strategy.
 * - Send response only carries `message_id` (no `recipient_id`).
 * - Mark-as-read is a no-op (platform doesn't expose it).
 */

import {
  MediaError,
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
  type MediaUploadOptions,
  type ReactionData,
  type SendResult,
  type StatusUpdate,
  FileHashDedupStrategy,
  UploadStrategy,
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
  private readonly mediaCache?: MediaCache;
  private readonly mediaStrategy: MediaStrategy;
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
    this.mediaCache = config.mediaCache;
    this.mediaStrategy = new FileHashDedupStrategy(
      new UploadStrategy((file, opts) => this.uploadMedia(file, opts)),
    );
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
   * Send an image. Instagram only supports image attachments.
   *
   * Uses {@link MediaStrategy} so identical Buffer uploads dedup by
   * SHA-256 content hash (C-13.7).
   */
  async sendMedia(to: string, media: MediaPayload): Promise<SendResult> {
    if (media.type !== 'image') {
      throw new MediaError(
        `Instagram only supports image attachments. Received: ${media.type}`,
        'instagram',
      );
    }

    // Normalize stream → Buffer so dedup can hash.
    const normalized: MediaPayload =
      typeof media.data === 'string' || Buffer.isBuffer(media.data)
        ? media
        : { ...media, data: await streamToBuffer(media.data) };

    const resolved = await this.mediaStrategy.resolve(normalized);
    const url = resolved.kind === 'url' ? resolved.url : (resolved.handle.url ?? '');

    const response = await this.graphApi.post<InstagramSendResponse>(
      `${this.config.igId}/messages`,
      {
        recipient: { id: to },
        message: {
          attachments: [{ type: 'image', payload: { url } }],
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

  /** Instagram has no mark-as-read endpoint; this is a no-op. */
  async markAsRead(_messageId: string): Promise<void> {
    // intentionally empty
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
    file: Buffer | ReadableStream,
    options: MediaUploadOptions,
  ): Promise<MediaHandle> {
    const buffer = Buffer.isBuffer(file) ? file : await streamToBuffer(file);
    const blob = new Blob([buffer], { type: options.mimeType });

    const formData = new FormData();
    formData.append('file', blob, options.filename ?? 'file');
    formData.append('type', options.mimeType);

    const response = await this.graphApi.postFormData<{ id: string; url?: string }>(
      `${this.config.igId}/media`,
      formData,
    );

    return { mediaId: response.id, url: response.url };
  }

  async downloadMedia(mediaId: string): Promise<MediaDownload> {
    if (this.mediaCache) {
      return this.mediaCache.getOrDownload(mediaId, async () => {
        const mediaInfo = await this.graphApi.get<{ id: string; url: string; mime_type: string }>(
          mediaId,
        );
        const data = await this.graphApi.fetchBinary(mediaInfo.url);
        return { data, mimeType: mediaInfo.mime_type };
      });
    }
    const mediaInfo = await this.graphApi.get<{ id: string; url: string; mime_type: string }>(
      mediaId,
    );
    const data = await this.graphApi.fetchBinary(mediaInfo.url);
    return { data, mimeType: mediaInfo.mime_type };
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
      const result = await this.graphApi.get<{ data: Array<{ ice_breakers?: IceBreakerConfig[] }> }>(
        `${this.config.igId}/messenger_profile`,
        { fields: 'ice_breakers' },
      );
      return result.data?.[0]?.ice_breakers ?? [];
    },

    delete: async (): Promise<void> => {
      await this.graphApi.post(`${this.config.igId}/messenger_profile`, {
        fields: ['ice_breakers'],
        _method: 'DELETE',
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
    const mediaTypes = ['image', 'video', 'audio', 'sticker'] as const;

    for (const type of mediaTypes) {
      const media = msg[type];
      if (media && 'id' in media) {
        return {
          id: media.id,
          mimeType: 'mime_type' in media ? (media.mime_type as string) : undefined,
          caption: 'caption' in media ? (media.caption as string) : undefined,
        };
      }
    }

    return undefined;
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
