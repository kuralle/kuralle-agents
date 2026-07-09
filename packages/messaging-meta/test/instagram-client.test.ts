import { describe, it, expect, mock } from 'bun:test';
import { createHmac } from 'node:crypto';
import { InstagramClient } from '../src/instagram/client.ts';
import type { InstagramClientConfig } from '../src/instagram/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const APP_SECRET = 'test_instagram_secret';
const VERIFY_TOKEN = 'my_instagram_verify_token';
const IG_ID = 'IG_ACCOUNT_789';

const baseConfig: InstagramClientConfig = {
  accessToken: 'fake_ig_access_token',
  appSecret: APP_SECRET,
  igId: IG_ID,
  verifyToken: VERIFY_TOKEN,
};

function signBody(body: string): string {
  return 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');
}

/** Build an Instagram text message webhook payload. */
function makeTextPayload(text: string, senderIgsid = 'IGSID_123') {
  return {
    object: 'instagram',
    entry: [
      {
        id: IG_ID,
        time: 1678871661000,
        messaging: [
          {
            sender: { id: senderIgsid },
            recipient: { id: IG_ID },
            timestamp: 1678871661000,
            message: { mid: 'mid.ig456', text },
          },
        ],
      },
    ],
  };
}

/** Build an Instagram postback (ice breaker click) webhook payload. */
function makePostbackPayload(title: string, payload: string, senderIgsid = 'IGSID_123') {
  return {
    object: 'instagram',
    entry: [
      {
        id: IG_ID,
        time: 1678871662000,
        messaging: [
          {
            sender: { id: senderIgsid },
            recipient: { id: IG_ID },
            timestamp: 1678871662000,
            postback: { title, payload, mid: 'mid.igpostback001' },
          },
        ],
      },
    ],
  };
}

/** Build an Instagram reaction webhook payload. */
function makeReactionPayload(emoji = '\u{1f525}', senderIgsid = 'IGSID_123') {
  return {
    object: 'instagram',
    entry: [
      {
        id: IG_ID,
        time: 1678871663000,
        messaging: [
          {
            sender: { id: senderIgsid },
            recipient: { id: IG_ID },
            timestamp: 1678871663000,
            reaction: { emoji, mid: 'mid.igoriginal001', action: 'react' },
          },
        ],
      },
    ],
  };
}

/** Build an Instagram delivery receipt webhook payload. */
function makeDeliveryPayload(senderIgsid = 'IGSID_123') {
  return {
    object: 'instagram',
    entry: [
      {
        id: IG_ID,
        time: 1678871664000,
        messaging: [
          {
            sender: { id: senderIgsid },
            recipient: { id: IG_ID },
            timestamp: 1678871664000,
            delivery: { mids: ['mid.igdelivered001'], watermark: 1678871664000 },
          },
        ],
      },
    ],
  };
}

/** Build an Instagram echo webhook payload (should be skipped). */
function makeEchoPayload() {
  return {
    object: 'instagram',
    entry: [
      {
        id: IG_ID,
        time: 1678871665000,
        messaging: [
          {
            sender: { id: IG_ID },
            recipient: { id: 'IGSID_123' },
            timestamp: 1678871665000,
            message: { mid: 'mid.igecho001', text: 'Echo message', is_echo: true },
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
      'x-hub-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000',
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

describe('InstagramClient — webhook verification (GET)', () => {
  it('returns 200 with challenge when token matches', async () => {
    const client = new InstagramClient(baseConfig);
    const response = await client.handleWebhook(
      makeVerificationRequest(VERIFY_TOKEN, 'ig_challenge_xyz'),
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe('ig_challenge_xyz');
  });

  it('returns 403 when token does not match', async () => {
    const client = new InstagramClient(baseConfig);
    const response = await client.handleWebhook(
      makeVerificationRequest('wrong_token', 'ig_challenge_xyz'),
    );
    expect(response.status).toBe(403);
  });

  it('returns 403 when hub.mode is missing', async () => {
    const client = new InstagramClient(baseConfig);
    const url = `https://localhost/webhook?hub.verify_token=${VERIFY_TOKEN}&hub.challenge=test`;
    const response = await client.handleWebhook(new Request(url, { method: 'GET' }));
    expect(response.status).toBe(403);
  });

  it('returns 403 when hub.mode is not subscribe', async () => {
    const client = new InstagramClient(baseConfig);
    const url = `https://localhost/webhook?hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=test`;
    const response = await client.handleWebhook(new Request(url, { method: 'GET' }));
    expect(response.status).toBe(403);
  });
});

describe('InstagramClient — webhook POST (signature verification)', () => {
  it('returns 200 and calls handlers for valid signature', async () => {
    const client = new InstagramClient(baseConfig);
    const handler = mock(() => Promise.resolve());
    client.onMessage(handler);

    const response = await client.handleWebhook(
      makeSignedRequest(makeTextPayload('Hello')),
    );
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('returns 401 and does NOT call handlers when signature header is missing', async () => {
    const client = new InstagramClient(baseConfig);
    const handler = mock(() => Promise.resolve());
    client.onMessage(handler);

    const response = await client.handleWebhook(
      makeUnsignedRequest(makeTextPayload('Hello')),
    );
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 401 and does NOT call handlers for invalid signature', async () => {
    const client = new InstagramClient(baseConfig);
    const handler = mock(() => Promise.resolve());
    client.onMessage(handler);

    const response = await client.handleWebhook(
      makeBadSignatureRequest(makeTextPayload('Hello')),
    );
    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('InstagramClient — webhook POST (message dispatch)', () => {
  it('dispatches text message to onMessage handler', async () => {
    const client = new InstagramClient(baseConfig);
    let receivedText: string | undefined;
    client.onMessage(async (inbound) => {
      receivedText = inbound.text;
    });

    await client.handleWebhook(makeSignedRequest(makeTextPayload('Hello from Instagram')));
    expect(receivedText).toBe('Hello from Instagram');
  });

  it('dispatches postback (ice breaker click) to onMessage handler', async () => {
    const client = new InstagramClient(baseConfig);
    let receivedText: string | undefined;
    let receivedType: string | undefined;
    client.onMessage(async (inbound) => {
      receivedText = inbound.text;
      receivedType = inbound.type;
    });

    await client.handleWebhook(
      makeSignedRequest(makePostbackPayload('What are your hours?', 'HOURS_PAYLOAD')),
    );
    expect(receivedText).toBe('What are your hours?');
    expect(receivedType).toBe('interactive');
  });

  it('dispatches reaction to onReaction handler', async () => {
    const client = new InstagramClient(baseConfig);
    let receivedEmoji: string | undefined;
    let receivedMessageId: string | undefined;
    client.onReaction(async (data) => {
      receivedEmoji = data.emoji;
      receivedMessageId = data.messageId;
    });

    await client.handleWebhook(makeSignedRequest(makeReactionPayload('\u{1f525}')));
    expect(receivedEmoji).toBe('\u{1f525}');
    expect(receivedMessageId).toBe('mid.igoriginal001');
  });

  it('dispatches delivery receipt to onStatus handler', async () => {
    const client = new InstagramClient(baseConfig);
    let receivedStatus: string | undefined;
    client.onStatus(async (update) => {
      receivedStatus = update.status;
    });

    await client.handleWebhook(makeSignedRequest(makeDeliveryPayload()));
    expect(receivedStatus).toBe('delivered');
  });

  it('skips echo messages', async () => {
    const client = new InstagramClient(baseConfig);
    const handler = mock(() => Promise.resolve());
    client.onMessage(handler);

    await client.handleWebhook(makeSignedRequest(makeEchoPayload()));
    expect(handler).not.toHaveBeenCalled();
  });

  it('calls handler for every message (no client-level deduplication)', async () => {
    const client = new InstagramClient(baseConfig);
    const handler = mock(() => Promise.resolve());
    client.onMessage(handler);

    const payload = makeTextPayload('Dupe');
    await client.handleWebhook(makeSignedRequest(payload));
    await client.handleWebhook(makeSignedRequest(payload));
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe('InstagramClient — threadId format', () => {
  it('produces correct threadId format instagram:<igId>:<igsid>', async () => {
    const client = new InstagramClient(baseConfig);
    let threadId: string | undefined;
    client.onMessage(async (inbound) => {
      threadId = inbound.threadId;
    });

    await client.handleWebhook(
      makeSignedRequest(makeTextPayload('Hi', 'IGSID_456')),
    );
    expect(threadId).toBe(`instagram:${IG_ID}:IGSID_456`);
  });

  it('produces correct threadId on status updates', async () => {
    const client = new InstagramClient(baseConfig);
    let threadId: string | undefined;
    client.onStatus(async (update) => {
      threadId = update.threadId;
    });

    await client.handleWebhook(makeSignedRequest(makeDeliveryPayload('IGSID_789')));
    expect(threadId).toBeDefined();
    expect(threadId).toContain('instagram:');
    expect(threadId).toContain(IG_ID);
  });
});

describe('InstagramClient — Instagram-specific: sendMedia', () => {
  it('sendMedia with video URL uses video attachment type', async () => {
    const client = new InstagramClient(baseConfig);
    Object.assign((client as unknown as { graphApi: Record<string, unknown> }).graphApi, {
      post: async (_endpoint: string, body: unknown) => {
        (client as unknown as { _lastBody: unknown })._lastBody = body;
        return { message_id: 'mid.video' };
      },
    });

    await client.sendMedia('IGSID_123', {
      type: 'video',
      mimeType: 'video/mp4',
      data: 'https://example.com/video.mp4',
    });

    const body = (client as unknown as { _lastBody: { message?: { attachment?: { type?: string } } } })._lastBody;
    expect(body.message?.attachment?.type).toBe('video');
  });

  it('sendMedia with Buffer throws unsupported', async () => {
    const client = new InstagramClient(baseConfig);
    await expect(
      client.sendMedia('IGSID_123', {
        type: 'image',
        mimeType: 'image/png',
        data: Buffer.from('png'),
      }),
    ).rejects.toThrow(/public URL/i);
  });
});

describe('InstagramClient — unhappy paths', () => {
  it('handles POST with empty body', async () => {
    const client = new InstagramClient(baseConfig);
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
    const client = new InstagramClient(baseConfig);
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
    const client = new InstagramClient(baseConfig);
    const body = 'not-json-at-all';
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
    const client = new InstagramClient(baseConfig);
    const url = `https://localhost/webhook?hub.verify_token=${VERIFY_TOKEN}&hub.challenge=test_challenge`;
    const response = await client.handleWebhook(new Request(url, { method: 'GET' }));
    expect(response.status).toBe(403);
  });

  it('handles GET with hub.mode=unsubscribe', async () => {
    const client = new InstagramClient(baseConfig);
    const url = `https://localhost/webhook?hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=test_challenge`;
    const response = await client.handleWebhook(new Request(url, { method: 'GET' }));
    expect(response.status).toBe(403);
  });
});
