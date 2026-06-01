/**
 * @module whatsapp/client
 *
 * WhatsApp Cloud API client.
 *
 * Extends {@link BaseMetaClient} for shared webhook verification, payload
 * normalization, handler dispatch, and `/webhook` Hono sub-app. Templates,
 * Flows, phone-number management, CTA buttons, reactions, location, and
 * contact messages remain in this file as WhatsApp-specific surface.
 *
 * @example
 * ```ts
 * import { createWhatsAppClient } from '@kuralle-agents/messaging-meta/whatsapp';
 *
 * const client = createWhatsAppClient({
 *   accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
 *   appSecret: process.env.META_APP_SECRET!,
 *   phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
 *   verifyToken: process.env.WHATSAPP_VERIFY_TOKEN!,
 * });
 * ```
 */

import {
  MessagingError,
  WindowClosedError,
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
import { SmartSplitter } from '../message-splitter.js';
import type {
  NormalizedMessage,
  NormalizedReaction,
  NormalizedStatus,
} from '../webhook/normalizer.js';

import type {
  WhatsAppClientConfig,
  WhatsAppSendResponse,
  WhatsAppMediaResponse,
  TemplateMessage,
  TemplateInfo,
  TemplateDefinition,
  TemplateDefinitionComponent,
  TextOrTemplateOptions,
  ListMessage,
  ButtonMessage,
  CTAButtonMessage,
  FlowInteractiveInput,
  LocationPayload,
  ContactPayload,
  MediaObject,
  BusinessProfile,
  FlowDefinition,
  FlowInfo,
  FlowAssets,
} from './types.js';

import { WhatsAppFormatConverter } from './format.js';

// ---------------------------------------------------------------------------
// Raw WhatsApp types for PlatformClient generics
// ---------------------------------------------------------------------------

type WhatsAppInbound = NormalizedMessage;
type WhatsAppOutbound = Record<string, unknown>;

/** Internal config — base-client common fields threaded through the public config. */
type InternalWhatsAppConfig = WhatsAppClientConfig & BaseMetaClientConfig;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWhatsAppClient(config: WhatsAppClientConfig): WhatsAppClient {
  return new WhatsAppClient(config);
}

// ---------------------------------------------------------------------------
// WhatsAppClient
// ---------------------------------------------------------------------------

/**
 * Full-featured WhatsApp Cloud API client.
 *
 * Implements the `PlatformClient` interface via {@link BaseMetaClient}.
 * Layers WhatsApp-specific capabilities (templates, Flows, reactions, CTA
 * buttons, locations, contacts) on top.
 */
export class WhatsAppClient extends BaseMetaClient<
  WhatsAppInbound,
  WhatsAppOutbound,
  InternalWhatsAppConfig
> {
  readonly platform = 'whatsapp' as const;

  private readonly config: InternalWhatsAppConfig;
  private readonly formatConverterInstance: WhatsAppFormatConverter;
  private readonly mediaCache?: MediaCache;
  private readonly mediaStrategy: MediaStrategy;
  private readonly splitter = new SmartSplitter(4096);

  constructor(config: WhatsAppClientConfig) {
    const full = config as InternalWhatsAppConfig;
    const graphApi = new GraphAPIClient({
      accessToken: config.accessToken,
      appSecret: config.appSecret,
      apiVersion: config.apiVersion,
      baseUrl: config.baseUrl,
      retry: config.retry,
      rateLimiter: config.rateLimiter,
      platform: 'whatsapp',
      logger: config.logger,
    });
    super(full, graphApi);
    this.config = full;
    this.formatConverterInstance = new WhatsAppFormatConverter();
    this.mediaCache = config.mediaCache;
    this.mediaStrategy = new FileHashDedupStrategy(
      new UploadStrategy((file, opts) => this.uploadMedia(file, opts)),
    );
  }

  /** WhatsApp-specific format converter. */
  get formatConverter(): FormatConverter {
    return this.formatConverterInstance;
  }

  // =========================================================================
  // Outbound — core PlatformClient methods
  // =========================================================================

  /**
   * Send a text message, splitting via {@link SmartSplitter} to fit WhatsApp's
   * 4096-character limit. Long messages emit multiple sends; the last result
   * is returned.
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
   * Send a media message. Buffer uploads dedup via
   * {@link FileHashDedupStrategy} (C-13.7).
   */
  async sendMedia(to: string, media: MediaPayload): Promise<SendResult> {
    const mediaType = this.resolveMediaType(media.mimeType);

    // Normalize stream → Buffer so dedup can hash.
    const normalized: MediaPayload =
      typeof media.data === 'string' || Buffer.isBuffer(media.data)
        ? media
        : { ...media, data: await streamToBuffer(media.data) };

    const resolved = await this.mediaStrategy.resolve(normalized);

    const mediaObj: MediaObject =
      resolved.kind === 'url' ? { link: resolved.url } : { id: resolved.handle.mediaId };

    if (media.caption) mediaObj.caption = media.caption;
    if (media.filename) mediaObj.filename = media.filename;

    const response = await this.graphApi.post<WhatsAppSendResponse>(
      `${this.config.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: mediaType,
        [mediaType]: mediaObj,
      },
    );

    return this.toSendResult(to, response);
  }

  async sendInteractive(to: string, msg: InteractiveMessage): Promise<SendResult> {
    if (msg.action.type === 'buttons') {
      return this.sendInteractiveButtons(to, {
        body: { text: msg.body },
        header: msg.header?.type === 'text' ? { type: 'text', text: msg.header.content } : undefined,
        footer: msg.footer ? { text: msg.footer } : undefined,
        buttons: msg.action.buttons.map((b) => ({ id: b.id, title: b.title })),
      });
    }

    if (msg.action.type === 'list') {
      return this.sendListMessage(to, {
        body: { text: msg.body },
        header: msg.header?.type === 'text' ? { type: 'text', text: msg.header.content } : undefined,
        footer: msg.footer ? { text: msg.footer } : undefined,
        button: msg.action.button,
        sections: msg.action.sections,
      });
    }

    if (msg.action.type === 'flow') {
      return this.sendInteractiveFlow(to, {
        body: { text: msg.body },
        footer: msg.footer ? { text: msg.footer } : undefined,
        flowId: msg.action.flowId,
        flowCta: 'Continue',
        flowToken: msg.action.flowToken ?? '',
        flowAction: 'navigate',
        flowActionPayload: msg.action.parameters,
      });
    }

    throw new MessagingError(
      `Unsupported interactive type: ${(msg.action as { type: string }).type}`,
      'UNSUPPORTED_TYPE',
      'whatsapp',
    );
  }

  async sendRaw(to: string, payload: WhatsAppOutbound): Promise<SendResult> {
    const response = await this.graphApi.post<WhatsAppSendResponse>(
      `${this.config.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        ...payload,
      },
    );

    return this.toSendResult(to, response);
  }

  async markAsRead(messageId: string): Promise<void> {
    await this.graphApi.post(`${this.config.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    });
  }

  /** WhatsApp Cloud API does not support typing indicators — no-op. */
  async sendTypingIndicator(_to: string): Promise<void> {
    // intentionally empty
  }

  // =========================================================================
  // WhatsApp-specific — Templates
  // =========================================================================

  async sendTemplate(to: string, template: TemplateMessage): Promise<SendResult> {
    const response = await this.graphApi.post<WhatsAppSendResponse>(
      `${this.config.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'template',
        template,
      },
    );

    return this.toSendResult(to, response);
  }

  /**
   * Send a text message with automatic template fallback on a
   * {@link WindowClosedError} (24-hour customer-service window expired).
   *
   * @deprecated Bypasses the window-safe {@link OutboundPipeline}. Route outbound
   * through `createMessagingRouter` / `OutboundPipeline` with `windowGuard` instead.
   */
  async sendTextOrTemplate(to: string, opts: TextOrTemplateOptions): Promise<SendResult> {
    try {
      return await this.sendText(to, opts.text);
    } catch (error) {
      if (error instanceof WindowClosedError) {
        return this.sendTemplate(to, opts.fallbackTemplate);
      }
      throw error;
    }
  }

  // =========================================================================
  // WhatsApp-specific — Interactive messages
  // =========================================================================

  async sendListMessage(to: string, list: ListMessage): Promise<SendResult> {
    const response = await this.graphApi.post<WhatsAppSendResponse>(
      `${this.config.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'list',
          header: list.header,
          body: list.body,
          footer: list.footer,
          action: {
            button: list.button,
            sections: list.sections,
          },
        },
      },
    );

    return this.toSendResult(to, response);
  }

  async sendInteractiveButtons(to: string, msg: ButtonMessage): Promise<SendResult> {
    const response = await this.graphApi.post<WhatsAppSendResponse>(
      `${this.config.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'button',
          header: msg.header,
          body: msg.body,
          footer: msg.footer,
          action: {
            buttons: msg.buttons.slice(0, 3).map((b) => ({
              type: 'reply',
              reply: { id: b.id, title: b.title.slice(0, 20) },
            })),
          },
        },
      },
    );

    return this.toSendResult(to, response);
  }

  async sendCTAButton(to: string, cta: CTAButtonMessage): Promise<SendResult> {
    const response = await this.graphApi.post<WhatsAppSendResponse>(
      `${this.config.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'cta_url',
          header: cta.header,
          body: cta.body,
          footer: cta.footer,
          action: {
            name: cta.name,
            parameters: cta.parameters,
          },
        },
      },
    );

    return this.toSendResult(to, response);
  }

  async sendInteractiveFlow(to: string, flow: FlowInteractiveInput): Promise<SendResult> {
    const response = await this.graphApi.post<WhatsAppSendResponse>(
      `${this.config.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'interactive',
        interactive: {
          type: 'flow',
          body: flow.body,
          footer: flow.footer,
          action: {
            name: 'flow',
            parameters: {
              flow_message_version: '3',
              flow_id: flow.flowId,
              flow_cta: flow.flowCta,
              flow_token: flow.flowToken,
              flow_action: flow.flowAction,
              flow_action_payload: flow.flowActionPayload,
            },
          },
        },
      },
    );

    return this.toSendResult(to, response);
  }

  // =========================================================================
  // WhatsApp-specific — Reactions, location, contacts
  // =========================================================================

  async sendReaction(to: string, messageId: string, emoji: string): Promise<SendResult> {
    const response = await this.graphApi.post<WhatsAppSendResponse>(
      `${this.config.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'reaction',
        reaction: { message_id: messageId, emoji },
      },
    );

    return this.toSendResult(to, response);
  }

  async sendLocation(to: string, location: LocationPayload): Promise<SendResult> {
    const response = await this.graphApi.post<WhatsAppSendResponse>(
      `${this.config.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'location',
        location,
      },
    );

    return this.toSendResult(to, response);
  }

  async sendContacts(to: string, contacts: ContactPayload[]): Promise<SendResult> {
    const response = await this.graphApi.post<WhatsAppSendResponse>(
      `${this.config.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'contacts',
        contacts,
      },
    );

    return this.toSendResult(to, response);
  }

  // =========================================================================
  // Template management
  // =========================================================================

  readonly templates = {
    list: async (wabaId: string): Promise<TemplateInfo[]> => {
      const result = await this.graphApi.get<{ data: RawTemplateListRow[] }>(
        `${wabaId}/message_templates`,
      );
      return result.data.map(mapListTemplateRow);
    },

    create: async (wabaId: string, template: TemplateDefinition): Promise<TemplateInfo> => {
      return this.graphApi.post<TemplateInfo>(`${wabaId}/message_templates`, template);
    },

    delete: async (wabaId: string, name: string): Promise<void> => {
      await this.graphApi.post(`${wabaId}/message_templates`, {
        name,
        _method: 'DELETE',
      });
    },
  };

  // =========================================================================
  // Phone number management
  // =========================================================================

  readonly phoneNumbers = {
    requestCode: async (
      phoneNumberId: string,
      method: 'SMS' | 'VOICE',
      language: string,
    ): Promise<void> => {
      await this.graphApi.post(`${phoneNumberId}/request_code`, {
        code_method: method,
        language,
      });
    },

    verifyCode: async (phoneNumberId: string, code: string): Promise<void> => {
      await this.graphApi.post(`${phoneNumberId}/verify_code`, { code });
    },

    register: async (phoneNumberId: string, pin: string): Promise<void> => {
      await this.graphApi.post(`${phoneNumberId}/register`, {
        messaging_product: 'whatsapp',
        pin,
      });
    },

    getBusinessProfile: async (phoneNumberId: string): Promise<BusinessProfile> => {
      const result = await this.graphApi.get<{ data: BusinessProfile[] }>(
        `${phoneNumberId}/whatsapp_business_profile`,
        { fields: 'about,address,description,email,profile_picture_url,websites,vertical' },
      );
      return result.data[0] ?? {};
    },

    updateBusinessProfile: async (
      phoneNumberId: string,
      profile: Partial<BusinessProfile>,
    ): Promise<void> => {
      await this.graphApi.post(`${phoneNumberId}/whatsapp_business_profile`, {
        messaging_product: 'whatsapp',
        ...profile,
      });
    },
  };

  // =========================================================================
  // WhatsApp Flows management
  // =========================================================================

  readonly flows = {
    create: async (wabaId: string, flow: FlowDefinition): Promise<FlowInfo> => {
      return this.graphApi.post<FlowInfo>(`${wabaId}/flows`, flow);
    },

    update: async (flowId: string, flow: Partial<FlowDefinition>): Promise<FlowInfo> => {
      return this.graphApi.post<FlowInfo>(flowId, flow);
    },

    publish: async (flowId: string): Promise<void> => {
      await this.graphApi.post(`${flowId}/publish`, {});
    },

    delete: async (flowId: string): Promise<void> => {
      await this.graphApi.post(flowId, { status: 'DEPRECATED' });
    },

    getAssets: async (flowId: string): Promise<FlowAssets> => {
      return this.graphApi.get<FlowAssets>(`${flowId}/assets`);
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

    const formData = new FormData();
    formData.append('file', blob, options.filename ?? 'file');
    formData.append('messaging_product', 'whatsapp');
    formData.append('type', options.mimeType);

    const response = await this.graphApi.postFormData<{ id: string }>(
      `${this.config.phoneNumberId}/media`,
      formData,
    );

    return { mediaId: response.id };
  }

  async downloadMedia(mediaId: string): Promise<MediaDownload> {
    if (this.mediaCache) {
      return this.mediaCache.getOrDownload(mediaId, async () => {
        const mediaInfo = await this.graphApi.get<WhatsAppMediaResponse>(mediaId);
        const data = await this.graphApi.fetchBinary(mediaInfo.url);
        return { data, mimeType: mediaInfo.mime_type };
      });
    }
    const mediaInfo = await this.graphApi.get<WhatsAppMediaResponse>(mediaId);
    const data = await this.graphApi.fetchBinary(mediaInfo.url);
    return { data, mimeType: mediaInfo.mime_type };
  }

  // =========================================================================
  // Template-method hooks — called by BaseMetaClient during webhook dispatch
  // =========================================================================

  protected toInboundMessage(msg: NormalizedMessage): InboundMessage {
    const threadId = `whatsapp:${this.config.phoneNumberId}:${msg.from}`;

    return {
      id: msg.id,
      platform: 'whatsapp',
      threadId,
      customerId: msg.from,
      from: {
        id: msg.from,
        name: msg.contactName,
        phone: msg.from,
      },
      timestamp: new Date(parseInt(msg.timestamp, 10) * 1000),
      type: this.mapMessageType(msg.type),
      text: msg.text?.body ?? this.extractTextFallback(msg),
      media: this.extractMedia(msg),
      location: msg.location,
      button: msg.button
        ? { payload: msg.button.payload, text: msg.button.text }
        : undefined,
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
            formResponse: parseNfmReply(msg.interactive.nfm_reply),
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
      threadId: `whatsapp:${status.phoneNumberId}:${status.recipientId}`,
      error: status.errors?.[0]
        ? {
            code: String(status.errors[0].code),
            title: status.errors[0].title,
            message: status.errors[0].message,
          }
        : undefined,
      conversation: status.conversation
        ? {
            id: status.conversation.id,
            expirationTimestamp: status.conversation.expiration_timestamp
              ? new Date(parseInt(status.conversation.expiration_timestamp, 10) * 1000)
              : undefined,
            origin: status.conversation.origin?.type,
          }
        : undefined,
      pricing: status.pricing
        ? {
            model: status.pricing.pricing_model,
            category: status.pricing.category,
          }
        : undefined,
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

  private toSendResult(to: string, response: WhatsAppSendResponse): SendResult {
    return {
      messageId: response.messages[0]?.id ?? '',
      threadId: `whatsapp:${this.config.phoneNumberId}:${to}`,
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
      document: 'document',
      sticker: 'sticker',
      location: 'location',
      contacts: 'contacts',
      interactive: 'interactive',
      button: 'interactive',
      reaction: 'reaction',
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
      if (media && 'id' in media) {
        return {
          id: media.id,
          mimeType: 'mime_type' in media ? (media.mime_type as string) : undefined,
          caption: 'caption' in media ? (media.caption as string) : undefined,
          filename: 'filename' in media ? (media.filename as string) : undefined,
        };
      }
    }

    return undefined;
  }

  private async sendSingleText(to: string, text: string): Promise<SendResult> {
    const response = await this.graphApi.post<WhatsAppSendResponse>(
      `${this.config.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body: text },
      },
    );

    return this.toSendResult(to, response);
  }

  private resolveMediaType(mimeType: string): string {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    return 'document';
  }
}

// ---------------------------------------------------------------------------
// Template list mapping
// ---------------------------------------------------------------------------

type RawTemplateListRow = {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components: TemplateDefinitionComponent[];
  quality_score?: { score?: string };
  paused?: boolean;
};

function mapListTemplateRow(raw: RawTemplateListRow): TemplateInfo {
  const quality = raw.quality_score?.score?.toUpperCase();
  const statusUpper = raw.status.toUpperCase();
  const paused =
    raw.paused === true || statusUpper === 'PAUSED' || quality === 'PAUSED';
  return {
    id: raw.id,
    name: raw.name,
    language: raw.language,
    status: raw.status,
    category: raw.category,
    components: raw.components,
    quality,
    paused,
  };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function parseNfmReply(
  nfm?: { name?: string; response_json: string },
): Record<string, unknown> | undefined {
  if (!nfm?.response_json) return undefined;
  try {
    const parsed: unknown = JSON.parse(nfm.response_json);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

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
