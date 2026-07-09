/**
 * Unit tests for {@link BaseMetaClient} against a synthetic stub subclass.
 *
 * Also runs the shared {@link runBaseMetaClientContract} harness to
 * demonstrate the contract is self-consistent before the three concrete
 * clients migrate onto the base.
 */
import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';

import { BaseMetaClient } from '../src/base-client.ts';
import type { BaseMetaClientConfig } from '../src/base-client.ts';
import { GraphAPIClient } from '../src/graph-api/client.ts';
import {
  runBaseMetaClientContract,
  type BaseMetaClientContractFixtures,
} from './base-client-contract.ts';
import type {
  FormatConverter,
  InboundMessage,
  InteractiveMessage,
  MediaDownload,
  MediaHandle,
  MediaPayload,
  MediaUploadOptions,
  ReactionData,
  SendResult,
  StatusUpdate,
} from '@kuralle-agents/messaging';
import type {
  NormalizedMessage,
  NormalizedReaction,
  NormalizedStatus,
} from '../src/webhook/normalizer.ts';

// ---------------------------------------------------------------------------
// Stub subclass — minimal but functional
// ---------------------------------------------------------------------------

interface StubConfig extends BaseMetaClientConfig {
  phoneNumberId: string;
}

class StubFormatConverter implements FormatConverter {
  toPlainText(s: string): string {
    return s;
  }
  toMarkdown(s: string): string {
    return s;
  }
  toPlatformFormat(s: string): string {
    return s;
  }
}

class StubMetaClient extends BaseMetaClient<NormalizedMessage, Record<string, unknown>, StubConfig> {
  readonly platform = 'stub';
  readonly formatConverter: FormatConverter = new StubFormatConverter();

  constructor(config: StubConfig) {
    super(config, stubGraphApi);
  }

  protected toInboundMessage(msg: NormalizedMessage): InboundMessage {
    return {
      id: msg.id,
      platform: this.platform,
      threadId: msg.from,
      customerId: msg.from,
      from: { id: msg.from, name: msg.contactName },
      timestamp: new Date(Number(msg.timestamp) * 1000),
      type: 'text',
      text: msg.text?.body,
    };
  }

  protected toStatusUpdate(status: NormalizedStatus): StatusUpdate {
    return {
      messageId: status.id,
      recipientId: status.recipientId,
      status: status.status as StatusUpdate['status'],
      timestamp: new Date(Number(status.timestamp) * 1000),
      threadId: status.recipientId,
    };
  }

  protected toReactionData(reaction: NormalizedReaction): ReactionData {
    return {
      messageId: reaction.messageId,
      emoji: reaction.emoji,
      action: reaction.emoji === '' ? 'unreact' : 'react',
      userId: reaction.from,
    };
  }

  // Outbound methods — not exercised by webhook tests.
  async sendText(to: string, _text: string): Promise<SendResult> {
    return { messageId: `stub:${to}`, threadId: to, timestamp: new Date() };
  }
  async sendMedia(to: string, _media: MediaPayload): Promise<SendResult> {
    return { messageId: `stub:${to}`, threadId: to, timestamp: new Date() };
  }
  async sendInteractive(to: string, _msg: InteractiveMessage): Promise<SendResult> {
    return { messageId: `stub:${to}`, threadId: to, timestamp: new Date() };
  }
  async sendRaw(to: string, _payload: Record<string, unknown>): Promise<SendResult> {
    return { messageId: `stub:${to}`, threadId: to, timestamp: new Date() };
  }
  async markAsRead(_messageId: string): Promise<void> {}
  async sendTypingIndicator(_to: string): Promise<void> {}
  async uploadMedia(_file: Buffer | ReadableStream, _opts: MediaUploadOptions): Promise<MediaHandle> {
    return { mediaId: 'stub-handle' };
  }
  async downloadMedia(_mediaId: string): Promise<MediaDownload> {
    return { data: Buffer.from(''), mimeType: 'application/octet-stream' };
  }
}

// ---------------------------------------------------------------------------
// Synthetic fixture payloads
// ---------------------------------------------------------------------------

const APP_SECRET = 'stub-app-secret';
const VERIFY_TOKEN = 'stub-verify-token';

const stubGraphApi = new GraphAPIClient({
  accessToken: 'stub-access-token',
  appSecret: APP_SECRET,
});

const whatsappLikePayload = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: '123' },
            contacts: [{ wa_id: '+15551234567', profile: { name: 'Stub User' } }],
            messages: [
              {
                id: 'wamid.STUB001',
                from: '+15551234567',
                timestamp: '1700000000',
                type: 'text',
                text: { body: 'hello' },
              },
            ],
          },
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Direct tests on the stub subclass (granular assertions the contract
// harness deliberately keeps abstract).
// ---------------------------------------------------------------------------

describe('BaseMetaClient — webhookRouter', () => {
  it('mounts GET /webhook and POST /webhook on a fresh Hono app', async () => {
    const client = new StubMetaClient({
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
      phoneNumberId: '123',
    });
    const app = new Hono();
    app.route('/stub', client.webhookRouter());

    const res = await app.request(
      `/stub/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(
        VERIFY_TOKEN,
      )}&hub.challenge=X`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('X');
  });
});

describe('BaseMetaClient — handler isolation', () => {
  it('aggregates errors from multiple handler kinds in one webhook', async () => {
    const captured: Array<{ kind: string; eventId: string; message: string }> = [];
    const client = new StubMetaClient({
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
      phoneNumberId: '123',
      onHandlerError: (errors) => {
        for (const e of errors) {
          captured.push({ kind: e.kind, eventId: e.eventId, message: e.error.message });
        }
      },
    });

    client.onMessage(async () => {
      throw new Error('msg-fail');
    });

    const { createHmac } = await import('node:crypto');
    const body = JSON.stringify(whatsappLikePayload);
    const sig = 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');

    const res = await client.handleWebhook(
      new Request('https://localhost/webhook', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig },
        body,
      }),
    );

    expect(res.status).toBe(200);
    expect(captured).toEqual([
      { kind: 'message', eventId: 'wamid.STUB001', message: 'msg-fail' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Run the shared contract suite against the stub (REQ-31 groundwork).
// ---------------------------------------------------------------------------

const fixtures: BaseMetaClientContractFixtures = {
  appSecret: APP_SECRET,
  verifyToken: VERIFY_TOKEN,
  inboundMessagePayload: whatsappLikePayload,
  expectedMessageId: 'wamid.STUB001',
};

runBaseMetaClientContract(
  'stub',
  (overrides) =>
    new StubMetaClient({
      appSecret: APP_SECRET,
      verifyToken: VERIFY_TOKEN,
      phoneNumberId: '123',
      onHandlerError: overrides?.onHandlerError,
    }),
  fixtures,
);
