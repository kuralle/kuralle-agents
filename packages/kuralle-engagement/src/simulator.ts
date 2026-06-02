import type { Runtime } from '@kuralle-agents/core';
import { createMessagingRouter } from '@kuralle-agents/messaging';
import type {
  InboundMessage,
  InteractiveMessage,
  MediaPayload,
  OutboundSink,
  OutboundTemplate,
  PlatformClient,
  SendResult,
  WindowStore,
} from '@kuralle-agents/messaging';
import type { EngagementBridge } from './engagement.js';

export interface SimChannel {
  platform: string;
}

export type SimSendKind = 'text' | 'interactive' | 'template' | 'media' | 'tagged-text';

export interface SimSend {
  channel: string;
  kind: SimSendKind;
  detail: string;
}

export type SimInboundInput =
  | { text: string }
  | { interactive: { id: string; title?: string } }
  | { button: { payload: string; text?: string } };

export interface Simulator {
  send(channel: string, threadId: string, input: SimInboundInput): Promise<SimSend[]>;
  window(threadId: string): Promise<{ open: boolean; expiresAt: Date | null }>;
  sends(channel?: string): SimSend[];
  readonly platforms: Record<string, PlatformClient>;
  readonly router: ReturnType<typeof createMessagingRouter>;
}

export interface CreateSimulatorOptions {
  runtime: Runtime;
  bridge: EngagementBridge;
  channels: string[];
  windowStore: WindowStore;
  defaultCustomerId?: (threadId: string) => string;
}

function renderInteractiveDetail(interactive: InteractiveMessage): string {
  const body = interactive.body;
  if (interactive.action.type === 'buttons') {
    const opts = interactive.action.buttons.map((b) => `(${b.id}:${b.title})`).join('');
    return `[buttons] ${body} :: ${opts}`;
  }
  if (interactive.action.type === 'list') {
    const rows = interactive.action.sections
      .flatMap((s) => s.rows.map((r) => `(${r.id}:${r.title})`))
      .join('');
    const listBtn = interactive.action.button;
    return `[list] ${body} :: ${listBtn} :: ${rows}`;
  }
  return `[${interactive.action.type}] ${body}`;
}

function renderMediaDetail(media: MediaPayload): string {
  const cap = media.caption ? ` caption=${media.caption}` : '';
  return `${media.type}/${media.mimeType}${cap}`;
}

type RecordingClient = PlatformClient &
  OutboundSink & {
    deliver(message: InboundMessage): Promise<void>;
  };

function createRecordingPlatform(
  channel: string,
  allSends: SimSend[],
): RecordingClient {
  const handlers: Array<(message: InboundMessage, raw: unknown) => Promise<void>> = [];
  let seq = 0;

  const makeResult = (threadId: string): SendResult => ({
    messageId: `sim-${channel}-${seq++}`,
    threadId,
    timestamp: new Date(),
  });

  const record = (kind: SimSendKind, detail: string) => {
    allSends.push({ channel, kind, detail });
  };

  return {
    platform: channel,
    handleWebhook: async () => new Response('OK'),
    onMessage: (handler) => {
      handlers.push(handler);
    },
    onStatus: () => {},
    onReaction: () => {},
    sendText: async (_to, text) => {
      record('text', text);
      return makeResult(_to);
    },
    sendTextWithTag: async (_to, text, tag) => {
      record('tagged-text', `${text}[tag=${tag}]`);
      return makeResult(_to);
    },
    sendTemplate: async (_to: string, template: OutboundTemplate) => {
      record('template', template.name);
      return makeResult(_to);
    },
    sendInteractive: async (_to, interactive) => {
      record('interactive', renderInteractiveDetail(interactive));
      return makeResult(_to);
    },
    sendMedia: async (_to, media) => {
      record('media', renderMediaDetail(media));
      return makeResult(_to);
    },
    sendRaw: async (_to) => makeResult(_to),
    markAsRead: async () => {},
    sendTypingIndicator: async () => {},
    uploadMedia: async () => ({ mediaId: 'mock' }),
    downloadMedia: async () => ({ data: Buffer.from(''), mimeType: 'text/plain' }),
    formatConverter: {
      toPlainText: (t) => t,
      toMarkdown: (t) => t,
      toPlatformFormat: (t) => t,
    },
    webhookRouter: () => {
      throw new Error('webhook not used in simulator');
    },
    deliver: async (message) => {
      for (const handler of handlers) {
        await handler(message, message);
      }
    },
  };
}

function buildInboundMessage(
  channel: string,
  threadId: string,
  customerId: string,
  messageId: string,
  input: SimInboundInput,
): InboundMessage {
  const base = {
    id: messageId,
    platform: channel,
    threadId,
    customerId,
    from: { id: customerId, name: 'Simulator' },
    timestamp: new Date(),
  };

  if ('text' in input) {
    return { ...base, type: 'text', text: input.text };
  }

  if ('button' in input) {
    if (channel === 'instagram') {
      return {
        ...base,
        type: 'interactive',
        button: { payload: input.button.payload, text: input.button.text ?? input.button.payload },
      };
    }
    return {
      ...base,
      type: 'text',
      text: input.button.payload,
    };
  }

  const { id, title } = input.interactive;
  if (channel === 'whatsapp' || channel === 'instagram') {
    return {
      ...base,
      type: 'interactive',
      interactive: { type: 'button_reply', id, title: title ?? id },
    };
  }
  return {
    ...base,
    type: 'text',
    text: id,
  };
}

export function createSimulator(opts: CreateSimulatorOptions): Simulator {
  const allSends: SimSend[] = [];
  const platforms: Record<string, PlatformClient> = {};
  const clients: Record<string, RecordingClient> = {};

  for (const channel of opts.channels) {
    const client = createRecordingPlatform(channel, allSends);
    clients[channel] = client;
    platforms[channel] = client;
  }

  const router = createMessagingRouter({
    runtime: opts.runtime,
    platforms,
    windowStore: opts.windowStore,
    ...opts.bridge,
  });

  const customerFor = opts.defaultCustomerId ?? ((threadId: string) => threadId);
  let inboundSeq = 0;

  return {
    platforms,
    router,
    async send(channel, threadId, input) {
      const client = clients[channel];
      if (!client) {
        throw new Error(`Simulator channel "${channel}" is not configured`);
      }
      const start = allSends.length;
      const messageId = `in-${++inboundSeq}`;
      const customerId = customerFor(threadId);
      await client.deliver(buildInboundMessage(channel, threadId, customerId, messageId, input));
      return allSends.slice(start);
    },
    async window(threadId) {
      const state = await opts.windowStore.get(threadId);
      return { open: state.open, expiresAt: state.expiresAt };
    },
    sends(channel) {
      if (channel === undefined) return [...allSends];
      return allSends.filter((s) => s.channel === channel);
    },
  };
}
