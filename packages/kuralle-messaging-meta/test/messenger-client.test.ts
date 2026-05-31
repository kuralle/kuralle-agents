import { describe, it, expect, mock } from 'bun:test';
import { createHmac } from 'node:crypto';
import { MessengerClient } from '../src/messenger/client.ts';
import type { MessengerClientConfig } from '../src/messenger/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const APP_SECRET = 'test_messenger_secret';
const VERIFY_TOKEN = 'my_messenger_verify_token';
const PAGE_ID = '123456789';

const baseConfig: MessengerClientConfig = {
  pageAccessToken: 'fake_page_access_token',
  appSecret: APP_SECRET,
  pageId: PAGE_ID,
  verifyToken: VERIFY_TOKEN,
};

function signBody(body: string): string {
  return 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');
}

/** Build a Messenger text message webhook payload. */
function makeTextPayload(text: string, senderPsid = 'USER_PSID_001') {
  return {
    object: 'page',
    entry: [
      {
        id: PAGE_ID,
        time: 1678871661000,
        messaging: [
          {
            sender: { id: senderPsid },
            recipient: { id: PAGE_ID },
            timestamp: 1678871661000,
            message: { mid: 'mid.text123', text },
          },
        ],
      },
    ],
  };
}

/** Build a Messenger postback webhook payload. */
function makePostbackPayload(title: string, payload: string, senderPsid = 'USER_PSID_001') {
  return {
    object: 'page',
    entry: [
      {
        id: PAGE_ID,
        time: 1678871662000,
        messaging: [
          {
            sender: { id: senderPsid },
            recipient: { id: PAGE_ID },
            timestamp: 1678871662000,
            postback: { title, payload, mid: 'mid.postback123' },
          },
        ],
      },
    ],
  };
}

/** Build a Messenger reaction webhook payload. */
function makeReactionPayload(emoji = '\u{1f44d}', senderPsid = 'USER_PSID_001') {
  return {
    object: 'page',
    entry: [
      {
        id: PAGE_ID,
        time: 1678871663000,
        messaging: [
          {
            sender: { id: senderPsid },
            recipient: { id: PAGE_ID },
            timestamp: 1678871663000,
            reaction: { emoji, mid: 'mid.original001', action: 'react' },
          },
        ],
      },
    ],
  };
}

/** Build a Messenger delivery receipt webhook payload. */
function makeDeliveryPayload(senderPsid = 'USER_PSID_001') {
  return {
    object: 'page',
    entry: [
      {
        id: PAGE_ID,
        time: 1678871664000,
        messaging: [
          {
            sender: { id: senderPsid },
            recipient: { id: PAGE_ID },
            timestamp: 1678871664000,
            delivery: { mids: ['mid.delivered001'], watermark: 1678871664000 },
          },
        ],
      },
    ],
  };
}

/** Build a Messenger echo webhook payload (should be skipped). */
function makeEchoPayload() {
  return {
    object: 'page',
    entry: [
      {
        id: PAGE_ID,
        time: 1678871665000,
        messaging: [
          {
            sender: { id: PAGE_ID },
            recipient: { id: 'USER_PSID_001' },
            timestamp: 1678871665000,
            message: { mid: 'mid.echo123', text: 'Echo message', is_echo: true },
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

function makeBadSignatureRequest(payload: unknown): Request {
  const body = JSON.stringify(payload);
  return new Request('https://localhost/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': 'sha256=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    },
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

describe('MessengerClient — webhook verification (GET)', () => {
  it('returns 200 with challenge when token matches', async () => {
    const client = new MessengerClient(baseConfig);
    const response = await client.handleWebhook(
      makeVerificationRequest(VERIFY_TOKEN, 'challenge_abc'),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe('challenge_abc');
  });

  it('returns 403 when token does not match', async () => {
    const client = new MessengerClient(baseConfig);
    const response = await client.handleWebhook(
      makeVerificationRequest('wrong_token', 'challenge_abc'),
    );
    expect(response.status).toBe(403);
  });

  it('returns 403 when hub.mode is missing', async () => {
    const client = new MessengerClient(baseConfig);
    const url = `https://localhost/webhook?hub.verify_token=${VERIFY_TOKEN}&hub.challenge=test`;
    const response = await client.handleWebhook(new Request(url, { method: 'GET' }));
    expect(response.status).toBe(403);
  });

  it('returns 403 when hub.mode is not subscribe', async () => {
    const client = new MessengerClient(baseConfig);
    const url = `https://localhost/webhook?hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=test`;
    const response = await client.handleWebhook(new Request(url, { method: 'GET' }));
    expect(response.status).toBe(403);
  });
});

describe('MessengerClient — webhook POST (signature verification)', () => {
  it('returns 200 and calls handlers for valid signature', async () => {
    const client = new MessengerClient(baseConfig);
    const handler = mock(() => Promise.resolve());
    client.onMessage(handler);

    const response = await client.handleWebhook(
      makeSignedRequest(makeTextPayload('Hello')),
    );
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('returns 401 and does NOT call handlers when signature header is missing', async () => {
    const client = new MessengerClient(baseConfig);
    const handler = mock(() => Promise.resolve());
    client.onMessage(handler);

    const response = await client.handleWebhook(
      makeUnsignedRequest(makeTextPayload('Hello')),
    );
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 401 and does NOT call handlers for invalid signature', async () => {
    const client = new MessengerClient(baseConfig);
    const handler = mock(() => Promise.resolve());
    client.onMessage(handler);

    const response = await client.handleWebhook(
      makeBadSignatureRequest(makeTextPayload('Hello')),
    );
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('MessengerClient — webhook POST (message dispatch)', () => {
  it('dispatches text message to onMessage handler', async () => {
    const client = new MessengerClient(baseConfig);
    let receivedText: string | undefined;
    client.onMessage(async (inbound) => {
      receivedText = inbound.text;
    });

    await client.handleWebhook(makeSignedRequest(makeTextPayload('Hello from Messenger')));
    expect(receivedText).toBe('Hello from Messenger');
  });

  it('dispatches postback to onMessage handler (postbacks are normalized as messages)', async () => {
    const client = new MessengerClient(baseConfig);
    let receivedText: string | undefined;
    let receivedType: string | undefined;
    client.onMessage(async (inbound) => {
      receivedText = inbound.text;
      receivedType = inbound.type;
    });

    await client.handleWebhook(
      makeSignedRequest(makePostbackPayload('Get Started', 'GET_STARTED_PAYLOAD')),
    );
    expect(receivedText).toBe('Get Started');
    expect(receivedType).toBe('interactive');
  });

  it('dispatches reaction to onReaction handler', async () => {
    const client = new MessengerClient(baseConfig);
    let receivedEmoji: string | undefined;
    client.onReaction(async (data) => {
      receivedEmoji = data.emoji;
    });

    await client.handleWebhook(makeSignedRequest(makeReactionPayload('\u{2764}\u{fe0f}')));
    expect(receivedEmoji).toBe('\u{2764}\u{fe0f}');
  });

  it('dispatches delivery receipt to onStatus handler', async () => {
    const client = new MessengerClient(baseConfig);
    let receivedStatus: string | undefined;
    client.onStatus(async (update) => {
      receivedStatus = update.status;
    });

    await client.handleWebhook(makeSignedRequest(makeDeliveryPayload()));
    expect(receivedStatus).toBe('delivered');
  });

  it('skips echo messages', async () => {
    const client = new MessengerClient(baseConfig);
    const handler = mock(() => Promise.resolve());
    client.onMessage(handler);

    await client.handleWebhook(makeSignedRequest(makeEchoPayload()));
    expect(handler).not.toHaveBeenCalled();
  });

  it('calls handler for every message (no client-level deduplication)', async () => {
    const client = new MessengerClient(baseConfig);
    const handler = mock(() => Promise.resolve());
    client.onMessage(handler);

    const payload = makeTextPayload('Dupe');
    await client.handleWebhook(makeSignedRequest(payload));
    await client.handleWebhook(makeSignedRequest(payload));
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe('MessengerClient — threadId format', () => {
  it('produces correct threadId format messenger:<pageId>:<psid>', async () => {
    const client = new MessengerClient(baseConfig);
    let threadId: string | undefined;
    client.onMessage(async (inbound) => {
      threadId = inbound.threadId;
    });

    await client.handleWebhook(
      makeSignedRequest(makeTextPayload('Hi', 'PSID_12345')),
    );
    expect(threadId).toBe(`messenger:${PAGE_ID}:PSID_12345`);
  });

  it('produces correct threadId on status updates', async () => {
    const client = new MessengerClient(baseConfig);
    let threadId: string | undefined;
    client.onStatus(async (update) => {
      threadId = update.threadId;
    });

    await client.handleWebhook(makeSignedRequest(makeDeliveryPayload('PSID_67890')));
    expect(threadId).toBeDefined();
    expect(threadId).toContain('messenger:');
    expect(threadId).toContain(PAGE_ID);
  });
});

describe('MessengerClient — unhappy paths', () => {
  it('handles POST with empty body', async () => {
    const client = new MessengerClient(baseConfig);
    const request = new Request('https://localhost/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '',
    });
    const response = await client.handleWebhook(request);
    // No signature header → 401
    expect(response.status).toBe(401);
  });

  it('handles POST with missing signature header', async () => {
    const client = new MessengerClient(baseConfig);
    const handler = mock(() => Promise.resolve());
    client.onMessage(handler);

    const body = JSON.stringify(makeTextPayload('Hello'));
    const request = new Request('https://localhost/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const response = await client.handleWebhook(request);
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('handles POST with valid signature but non-JSON body gracefully', async () => {
    const client = new MessengerClient(baseConfig);
    const body = 'not-json';
    const sig = signBody(body);
    const request = new Request('https://localhost/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sig,
      },
      body,
    });
    // JSON.parse will throw
    await expect(client.handleWebhook(request)).rejects.toThrow();
  });

  it('handles GET with missing hub.mode', async () => {
    const client = new MessengerClient(baseConfig);
    const url = `https://localhost/webhook?hub.verify_token=${VERIFY_TOKEN}&hub.challenge=test_challenge`;
    const response = await client.handleWebhook(new Request(url, { method: 'GET' }));
    expect(response.status).toBe(403);
  });

  it('handles GET with hub.mode=unsubscribe', async () => {
    const client = new MessengerClient(baseConfig);
    const url = `https://localhost/webhook?hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=test_challenge`;
    const response = await client.handleWebhook(new Request(url, { method: 'GET' }));
    expect(response.status).toBe(403);
  });
});
