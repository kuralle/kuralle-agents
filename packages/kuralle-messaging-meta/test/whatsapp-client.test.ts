import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { createHmac } from 'node:crypto';
import { WhatsAppClient } from '../src/whatsapp/client.ts';
import type { WhatsAppClientConfig } from '../src/whatsapp/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const APP_SECRET = 'test_secret_for_client';
const VERIFY_TOKEN = 'my_verify_token';
const PHONE_NUMBER_ID = '999888777';

const baseConfig: WhatsAppClientConfig = {
  accessToken: 'fake_access_token',
  appSecret: APP_SECRET,
  phoneNumberId: PHONE_NUMBER_ID,
  verifyToken: VERIFY_TOKEN,
};

function signBody(body: string): string {
  return 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');
}

/** Build a WhatsApp text message webhook payload. */
function makeTextPayload(text: string, from = '5511999999999') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: PHONE_NUMBER_ID, display_phone_number: '+1234' },
              contacts: [{ profile: { name: 'Test User' }, wa_id: from }],
              messages: [
                {
                  id: 'wamid.test123',
                  from,
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Build a WhatsApp status webhook payload. */
function makeStatusPayload(status: string) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: PHONE_NUMBER_ID },
              statuses: [
                {
                  id: 'wamid.status001',
                  recipient_id: '5511999999999',
                  status,
                  timestamp: '1700000001',
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Build a WhatsApp reaction webhook payload. */
function makeReactionPayload() {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: PHONE_NUMBER_ID },
              contacts: [],
              messages: [
                {
                  id: 'wamid.react001',
                  from: '5511999999999',
                  timestamp: '1700000002',
                  type: 'reaction',
                  reaction: { message_id: 'wamid.original', emoji: '\u{1f44d}' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function makeSignedRequest(payload: unknown): Request {
  const body = JSON.stringify(payload);
  return new Request('https://localhost/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signBody(body),
    },
    body,
  });
}

function makeUnsignedRequest(payload: unknown): Request {
  const body = JSON.stringify(payload);
  return new Request('https://localhost/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

function makeVerificationRequest(token: string, challenge: string): Request {
  const url = `https://localhost/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=${encodeURIComponent(challenge)}`;
  return new Request(url, { method: 'GET' });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WhatsAppClient — webhook verification (GET)', () => {
  it('returns 200 with challenge when token matches', async () => {
    const client = new WhatsAppClient(baseConfig);
    const response = await client.handleWebhook(
      makeVerificationRequest(VERIFY_TOKEN, 'challenge_abc'),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe('challenge_abc');
  });

  it('returns 403 when token does not match', async () => {
    const client = new WhatsAppClient(baseConfig);
    const response = await client.handleWebhook(
      makeVerificationRequest('wrong_token', 'challenge_abc'),
    );
    expect(response.status).toBe(403);
  });
});

describe('WhatsAppClient — webhook POST', () => {
  it('returns 200 and calls handlers for valid signature', async () => {
    const client = new WhatsAppClient(baseConfig);
    const handler = mock(() => Promise.resolve());
    client.onMessage(handler);

    const response = await client.handleWebhook(
      makeSignedRequest(makeTextPayload('Hello')),
    );
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('returns 401 and does NOT call handlers for invalid signature', async () => {
    const client = new WhatsAppClient(baseConfig);
    const handler = mock(() => Promise.resolve());
    client.onMessage(handler);

    const response = await client.handleWebhook(
      makeUnsignedRequest(makeTextPayload('Hello')),
    );
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('dispatches text message to onMessage handler', async () => {
    const client = new WhatsAppClient(baseConfig);
    let receivedText: string | undefined;
    client.onMessage(async (inbound) => {
      receivedText = inbound.text;
    });

    await client.handleWebhook(makeSignedRequest(makeTextPayload('Test message')));
    expect(receivedText).toBe('Test message');
  });

  it('dispatches status to onStatus handler', async () => {
    const client = new WhatsAppClient(baseConfig);
    let receivedStatus: string | undefined;
    client.onStatus(async (update) => {
      receivedStatus = update.status;
    });

    await client.handleWebhook(makeSignedRequest(makeStatusPayload('delivered')));
    expect(receivedStatus).toBe('delivered');
  });

  it('dispatches reaction to onReaction handler', async () => {
    const client = new WhatsAppClient(baseConfig);
    let receivedEmoji: string | undefined;
    client.onReaction(async (data) => {
      receivedEmoji = data.emoji;
    });

    await client.handleWebhook(makeSignedRequest(makeReactionPayload()));
    expect(receivedEmoji).toBe('\u{1f44d}');
  });

  it('calls handler for every message (no client-level deduplication)', async () => {
    const client = new WhatsAppClient(baseConfig);
    const handler = mock(() => Promise.resolve());
    client.onMessage(handler);

    const payload = makeTextPayload('Dupe');
    // Send same payload twice
    await client.handleWebhook(makeSignedRequest(payload));
    await client.handleWebhook(makeSignedRequest(payload));
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe('WhatsAppClient — toInboundMessage format', () => {
  it('produces correct threadId format whatsapp:{phoneNumberId}:{from}', async () => {
    const client = new WhatsAppClient(baseConfig);
    let threadId: string | undefined;
    client.onMessage(async (inbound) => {
      threadId = inbound.threadId;
    });

    await client.handleWebhook(
      makeSignedRequest(makeTextPayload('Hi', '441234567890')),
    );
    expect(threadId).toBe(`whatsapp:${PHONE_NUMBER_ID}:441234567890`);
  });
});

describe('WhatsAppClient — toStatusUpdate format', () => {
  it('includes threadId field in status update', async () => {
    const client = new WhatsAppClient(baseConfig);
    let threadId: string | undefined;
    client.onStatus(async (update) => {
      threadId = update.threadId;
    });

    await client.handleWebhook(makeSignedRequest(makeStatusPayload('read')));
    expect(threadId).toBeDefined();
    expect(threadId).toContain('whatsapp:');
    expect(threadId).toContain(PHONE_NUMBER_ID);
  });
});
