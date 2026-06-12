/// <reference types="@cloudflare/workers-types" />

import { DurableObject } from 'cloudflare:workers';
import { createRuntime } from '@kuralle-agents/core';
import type { HarnessStreamPart } from '@kuralle-agents/core';
import { createOpenAI } from '@ai-sdk/openai';
import { TurnQueue } from 'agents/chat';
import { createWhatsAppClient } from '@kuralle-agents/messaging-meta/whatsapp';
import type { NormalizedMessage } from '@kuralle-agents/messaging-meta/webhooks';
import {
  claimAndAppend,
  consentStop,
  conversationKeyToString,
  createInboundPipeline,
  defaultInboundChain,
  PlatformMediaResolver,
  recordWindow,
  resolveAndAttachMedia,
  runTurn,
  statusReactionErrorPhase,
  type ConversationKey,
  type InboundContext,
  type InboundEvent,
  type InboundMessage,
  type OutboundSender,
  type SendResult,
  type TurnResult,
} from '@kuralle-agents/messaging';
import { createDurableObjectInboundRuntime, createSqlExecutor } from '@kuralle-agents/cf-agent';
import { buildPharmacyAgent } from './pharmacy.js';
import { SqlSessionStore } from './wa-session-store.js';
import { PAYMENT_SIGNAL } from './token.js';

export interface WaEnv {
  OPENAI_API_KEY: string;
  PUBLIC_URL?: string;
  WHATSAPP_ACCESS_TOKEN: string;
  WHATSAPP_APP_SECRET: string;
  WHATSAPP_PHONE_NUMBER_ID: string;
  WHATSAPP_VERIFY_TOKEN: string;
  PORULLE_STOREFRONT_KEY?: string;
  COMMERCE_API_URL?: string;
}

type WhatsAppClient = ReturnType<typeof createWhatsAppClient>;

function toWhatsAppText(input: string): string {
  return input
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1: $2')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '*$1*')
    .replace(/^\s{0,3}#{1,6}\s+(.*)$/gm, '*$1*')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function textFromParts(parts: HarnessStreamPart[]): string {
  return parts
    .filter((part): part is Extract<HarnessStreamPart, { type: 'text-delta' }> => part.type === 'text-delta')
    .map((part) => part.delta)
    .join('')
    .trim();
}

class WhatsAppOutboundSender implements OutboundSender {
  constructor(private readonly whatsapp: Pick<WhatsAppClient, 'sendText'>) {}

  async send(ctx: InboundContext, result: TurnResult): Promise<void> {
    const text = textFromParts(result.parts);
    if (!text) return;
    await this.whatsapp.sendText(ctx.key.threadId, toWhatsAppText(text));
  }
}

function mapMessageType(type: string): InboundMessage['type'] {
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

function parseNfmReply(
  reply: NonNullable<NormalizedMessage['interactive']>['nfm_reply'] | undefined,
): Record<string, unknown> | undefined {
  if (!reply || typeof reply !== 'object' || !('response_json' in reply)) return undefined;
  const json = reply.response_json;
  if (typeof json !== 'string') return undefined;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function extractTextFallback(message: NormalizedMessage): string | undefined {
  if (message.image?.caption) return message.image.caption;
  if (message.video?.caption) return message.video.caption;
  if (message.document?.caption) return message.document.caption;
  if (message.button) return message.button.text;
  if (message.interactive?.button_reply) return message.interactive.button_reply.title;
  if (message.interactive?.list_reply) return message.interactive.list_reply.title;
  if (message.order?.text) return message.order.text;
  if (message.location) return message.location.name ?? `${message.location.latitude},${message.location.longitude}`;
  return undefined;
}

function extractMedia(message: NormalizedMessage): InboundMessage['media'] {
  if (message.image) {
    return {
      id: message.image.id,
      mimeType: message.image.mime_type,
      caption: message.image.caption,
    };
  }
  if (message.video) {
    return {
      id: message.video.id,
      mimeType: message.video.mime_type,
      caption: message.video.caption,
    };
  }
  if (message.audio) {
    return {
      id: message.audio.id,
      mimeType: message.audio.mime_type,
    };
  }
  if (message.document) {
    return {
      id: message.document.id,
      mimeType: message.document.mime_type,
      caption: message.document.caption,
      filename: message.document.filename,
    };
  }
  if (message.sticker) {
    return {
      id: message.sticker.id,
      mimeType: message.sticker.mime_type,
    };
  }
  return undefined;
}

function conversationKeyFromMessage(message: NormalizedMessage): ConversationKey {
  return {
    platform: 'whatsapp',
    businessId: message.phoneNumberId,
    threadId: message.from,
  };
}

function toInboundMessage(message: NormalizedMessage): InboundMessage {
  const key = conversationKeyFromMessage(message);
  const threadId = conversationKeyToString(key);
  return {
    id: message.id,
    platform: 'whatsapp',
    threadId,
    customerId: threadId,
    from: {
      id: message.from,
      name: message.contactName,
      phone: message.from,
    },
    timestamp: new Date(parseInt(message.timestamp, 10) * 1000),
    type: mapMessageType(message.type),
    text: message.text?.body ?? extractTextFallback(message),
    media: extractMedia(message),
    location: message.location,
    button: message.button ? { payload: message.button.payload, text: message.button.text } : undefined,
    interactive: message.interactive
      ? {
          type: message.interactive.type,
          id: message.interactive.button_reply?.id ?? message.interactive.list_reply?.id ?? '',
          title: message.interactive.button_reply?.title ?? message.interactive.list_reply?.title,
          description: message.interactive.list_reply?.description,
          formResponse: parseNfmReply(message.interactive.nfm_reply),
        }
      : undefined,
    context: message.context
      ? {
          messageId: message.context.message_id,
          from: message.context.from,
        }
      : undefined,
    raw: message,
  };
}

function messageEvent(message: InboundMessage): InboundEvent {
  return {
    kind: 'message',
    id: message.id,
    ts: message.timestamp.getTime(),
    data: message,
  };
}

function signalEvent(signalId: string, now: number): InboundEvent {
  return {
    kind: 'signal',
    id: `signal:${signalId}`,
    ts: now,
    data: { name: PAYMENT_SIGNAL, signalId, payload: { paid: true } },
  };
}

function okSendResult(to: string): SendResult {
  return { messageId: '', threadId: to, timestamp: new Date() };
}

/**
 * One Durable Object per WhatsApp user (`idFromName('wa:' + waId)`). Holds that
 * user's session + durable checkout state in DO SQLite and runs the SAME
 * pharmacy agent the web client uses — only the I/O channel differs.
 */
export class PharmacyWaAgent extends DurableObject<WaEnv> {
  private readonly turnQueue = new TurnQueue();

  private wire(key: ConversationKey) {
    const openai = createOpenAI({ apiKey: this.env.OPENAI_API_KEY });
    const model = openai('gpt-4.1-mini'); // vision-capable: reads the prescription image
    const baseUrl = this.env.PUBLIC_URL ?? 'http://localhost:8787';
    const sessionId = conversationKeyToString(key);

    const runtime = createRuntime({
      agents: [
        buildPharmacyAgent({
          model,
          durableObjectId: sessionId,
          baseUrl,
          payPath: '/wa-pay/',
          storefrontKey: this.env.PORULLE_STOREFRONT_KEY,
          commerceBaseUrl: this.env.COMMERCE_API_URL,
        }),
      ],
      defaultAgentId: 'pharmacy',
      sessionStore: new SqlSessionStore(this.ctx.storage.sql),
    });

    const whatsapp = createWhatsAppClient({
      accessToken: this.env.WHATSAPP_ACCESS_TOKEN,
      appSecret: this.env.WHATSAPP_APP_SECRET,
      phoneNumberId: this.env.WHATSAPP_PHONE_NUMBER_ID,
      verifyToken: this.env.WHATSAPP_VERIFY_TOKEN,
    });

    const sql = createSqlExecutor(this.ctx.storage.sql);
    const inboundRuntime = createDurableObjectInboundRuntime({
      sql,
      runtime,
      media: new PlatformMediaResolver(whatsapp),
      sender: new WhatsAppOutboundSender({
        sendText: async (to, text) => {
          const result = await whatsapp.sendText(to, text);
          return result ?? okSendResult(to);
        },
      }),
      queue: this.turnQueue,
      messageConcurrency: { strategy: 'debounce', debounceMs: 50 },
    });
    const inboundPipeline = createInboundPipeline([
      claimAndAppend(),
      statusReactionErrorPhase(),
      recordWindow(),
      consentStop(),
      resolveAndAttachMedia(defaultInboundChain()),
      runTurn(),
    ]);

    return { inboundPipeline, inboundRuntime, whatsapp };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/whatsapp') {
      const { message } = (await request.json()) as { from: string; message: NormalizedMessage };
      const inboundMessage = toInboundMessage(message);
      const key = conversationKeyFromMessage(message);
      const { inboundPipeline, inboundRuntime, whatsapp } = this.wire(key);
      // Mark the inbound message read + show a typing indicator while the model
      // thinks. Fire-and-forget: best-effort UX, never blocks or breaks the turn.
      if (message.id) void whatsapp.markAsRead(message.id, { typing: true }).catch(() => {});
      await inboundPipeline.ingest(key, messageEvent(inboundMessage), inboundRuntime);
      return new Response('ok');
    }

    if (request.method === 'POST' && url.pathname === '/wa-resume') {
      const body = (await request.json()) as { from: string; phoneNumberId?: string; signalId: string };
      const key = {
        platform: 'whatsapp',
        businessId: body.phoneNumberId ?? this.env.WHATSAPP_PHONE_NUMBER_ID,
        threadId: body.from,
      };
      const { inboundPipeline, inboundRuntime } = this.wire(key);
      await inboundPipeline.ingest(key, signalEvent(body.signalId, inboundRuntime.clock.now()), inboundRuntime);
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  }
}
