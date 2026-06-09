import { describe, it, expect } from 'bun:test';
import { HttpClient } from '@kuralle-agents/http-client';
import { GraphAPIClient } from '../src/graph-api/client.ts';
import {
  classifyMetaError,
  WindowClosedError,
  MessagingError,
} from '../src/graph-api/errors.ts';
import { normalizeWebhook } from '../src/webhook/normalizer.ts';
import { WhatsAppClient } from '../src/whatsapp/client.ts';
import { MessengerClient } from '../src/messenger/client.ts';
import { InstagramClient } from '../src/instagram/client.ts';
import { parseProductInquiry } from '../src/whatsapp/commerce.ts';
import type { WhatsAppClientConfig } from '../src/whatsapp/types.ts';
import type { MessengerClientConfig } from '../src/messenger/types.ts';
import type { InstagramClientConfig } from '../src/instagram/types.ts';
import type { NormalizedMessage } from '../src/webhook/normalizer.ts';
import type { InboundMessage } from '@kuralle-agents/messaging';

// ---------------------------------------------------------------------------
// Harness helpers — capture Graph API calls without HTTP
// ---------------------------------------------------------------------------

type CapturedCall =
  | { method: 'get' | 'post' | 'delete'; endpoint: string; body?: unknown; params?: Record<string, string> };

class ApiHarness {
  readonly calls: CapturedCall[] = [];

  bind(client: WhatsAppClient | MessengerClient | InstagramClient): void {
    Object.assign((client as unknown as { graphApi: GraphAPIClient }).graphApi, {
      get: async (endpoint: string, params?: Record<string, string>) => {
        this.calls.push({ method: 'get', endpoint, params });
        return { data: [], paging: undefined };
      },
      post: async (endpoint: string, body: unknown) => {
        this.calls.push({ method: 'post', endpoint, body });
        return {
          messaging_product: 'whatsapp',
          contacts: [{ input: 'x', wa_id: 'x' }],
          messages: [{ id: 'wamid.sent001' }],
          message_id: 'mid.sent001',
        };
      },
      delete: async (endpoint: string, opts?: { params?: Record<string, string>; body?: unknown }) => {
        this.calls.push({ method: 'delete', endpoint, params: opts?.params, body: opts?.body });
        return { success: true };
      },
    });
  }
}

const WA_CONFIG: WhatsAppClientConfig = {
  accessToken: 'token',
  appSecret: 'secret',
  phoneNumberId: '999888777',
  verifyToken: 'verify',
};

const MSGR_CONFIG: MessengerClientConfig = {
  pageAccessToken: 'token',
  appSecret: 'secret',
  pageId: '123456789',
  verifyToken: 'verify',
};

const IG_CONFIG: InstagramClientConfig = {
  accessToken: 'token',
  appSecret: 'secret',
  igId: 'IG_ACCOUNT_789',
  verifyToken: 'verify',
};

class WhatsAppHarness extends WhatsAppClient {
  convert(msg: NormalizedMessage): InboundMessage {
    return this.toInboundMessage(msg);
  }
}

// ---------------------------------------------------------------------------
// HTTP + Graph API delete
// ---------------------------------------------------------------------------

describe('meta conformance — HTTP DELETE', () => {
  it('HttpClient.delete sends DELETE with query params and optional JSON body', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (_input, init) => {
      const url = typeof _input === 'string' ? _input : (_input as URL).toString();
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const client = new HttpClient({ baseUrl: 'https://api.test/v1', fetchImpl });
    await client.delete('items/1', { params: { name: 'foo' }, body: { fields: ['x'] } });

    expect(calls[0].init?.method).toBe('DELETE');
    expect(calls[0].url).toContain('items/1?name=foo');
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ fields: ['x'] });
  });
});

// ---------------------------------------------------------------------------
// Fix 1 — flows.delete / deprecate
// ---------------------------------------------------------------------------

describe('meta conformance — WhatsApp flows', () => {
  it('delete uses HTTP DELETE; deprecate POSTs /deprecate', async () => {
    const harness = new ApiHarness();
    const client = new WhatsAppClient(WA_CONFIG);
    harness.bind(client);

    await client.flows.delete('flow-123');
    await client.flows.deprecate('flow-456');

    expect(harness.calls[0]).toEqual({ method: 'delete', endpoint: 'flow-123' });
    expect(harness.calls[1]).toEqual({
      method: 'post',
      endpoint: 'flow-456/deprecate',
      body: {},
    });
  });
});

// ---------------------------------------------------------------------------
// Fix 2 — real DELETE for templates, personas, ice breakers
// ---------------------------------------------------------------------------

describe('meta conformance — DELETE replacements', () => {
  it('templates.delete uses DELETE with name query param', async () => {
    const harness = new ApiHarness();
    const client = new WhatsAppClient(WA_CONFIG);
    harness.bind(client);

    await client.templates.delete('WABA', { name: 'hello_world' });

    expect(harness.calls[0]).toEqual({
      method: 'delete',
      endpoint: 'WABA/message_templates',
      params: { name: 'hello_world' },
    });
  });

  it('templates.delete supports hsm_id', async () => {
    const harness = new ApiHarness();
    const client = new WhatsAppClient(WA_CONFIG);
    harness.bind(client);

    await client.templates.delete('WABA', { hsm_id: '12345' });

    expect(harness.calls[0]?.params).toEqual({ hsm_id: '12345' });
  });

  it('personas.delete uses HTTP DELETE', async () => {
    const harness = new ApiHarness();
    const client = new MessengerClient(MSGR_CONFIG);
    harness.bind(client);

    await client.personas.delete('persona-99');

    expect(harness.calls[0]).toEqual({ method: 'delete', endpoint: 'persona-99' });
  });

  it('iceBreakers.delete uses DELETE with JSON body', async () => {
    const harness = new ApiHarness();
    const client = new InstagramClient(IG_CONFIG);
    harness.bind(client);

    await client.iceBreakers.delete();

    expect(harness.calls[0]).toEqual({
      method: 'delete',
      endpoint: `${IG_CONFIG.igId}/messenger_profile`,
      body: { fields: ['ice_breakers'] },
    });
  });
});

// ---------------------------------------------------------------------------
// Fix 3 — played status + pricing.type
// ---------------------------------------------------------------------------

describe('meta conformance — status normalization', () => {
  it('preserves played status and unknown status strings', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '123' },
                statuses: [
                  { id: 'w1', recipient_id: '1', status: 'played', timestamp: '1' },
                  { id: 'w2', recipient_id: '1', status: 'unknown_future', timestamp: '2' },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = normalizeWebhook(payload);
    expect(result.statuses[0]?.status).toBe('played');
    expect(result.statuses[1]?.status).toBe('unknown_future');
  });

  it('carries pricing.type through toStatusUpdate', () => {
    const harness = new WhatsAppHarness(WA_CONFIG);
    const inbound = harness.convert({
      id: 'wamid.test',
      from: '5511999999999',
      timestamp: '1700000000',
      type: 'text',
      phoneNumberId: WA_CONFIG.phoneNumberId,
    });

    expect(inbound.id).toBe('wamid.test');

    const status = (harness as unknown as {
      toStatusUpdate: (s: import('../src/webhook/normalizer.ts').NormalizedStatus) => import('@kuralle-agents/messaging').StatusUpdate;
    }).toStatusUpdate({
      id: 'wamid.sent',
      recipientId: '5511999999999',
      status: 'delivered',
      timestamp: '1700000001',
      phoneNumberId: WA_CONFIG.phoneNumberId,
      pricing: {
        billable: true,
        pricing_model: 'CBP',
        category: 'marketing_lite',
        type: 'free_entry_point',
      },
    });

    expect((status.pricing as { type?: string } | undefined)?.type).toBe('free_entry_point');
    expect(status.pricing?.category).toBe('marketing_lite');
  });
});

// ---------------------------------------------------------------------------
// Fix 4/5 — markAsRead + typing indicator
// ---------------------------------------------------------------------------

describe('meta conformance — WhatsApp typing indicator', () => {
  it('markAsRead with typing sends typing_indicator payload', async () => {
    const harness = new ApiHarness();
    const client = new WhatsAppClient(WA_CONFIG);
    harness.bind(client);

    await client.markAsRead('wamid.inbound1', { typing: true });

    expect(harness.calls[0]?.body).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.inbound1',
      typing_indicator: { type: 'text' },
    });
  });

  it('sendTypingIndicatorFor delegates to markAsRead with typing', async () => {
    const harness = new ApiHarness();
    const client = new WhatsAppClient(WA_CONFIG);
    harness.bind(client);

    await client.sendTypingIndicatorFor('wamid.inbound2');

    expect(harness.calls[0]?.body).toMatchObject({
      message_id: 'wamid.inbound2',
      typing_indicator: { type: 'text' },
    });
  });
});

describe('meta conformance — Messenger/Instagram mark_seen', () => {
  it('Messenger markAsRead sends mark_seen to recipient PSID', async () => {
    const harness = new ApiHarness();
    const client = new MessengerClient(MSGR_CONFIG);
    harness.bind(client);

    await client.markAsRead('USER_PSID');

    expect(harness.calls[0]?.body).toEqual({
      recipient: { id: 'USER_PSID' },
      sender_action: 'mark_seen',
    });
  });

  it('Instagram markAsRead sends mark_seen', async () => {
    const harness = new ApiHarness();
    const client = new InstagramClient(IG_CONFIG);
    harness.bind(client);

    await client.markAsRead('IGSID_123');

    expect(harness.calls[0]?.body).toEqual({
      recipient: { id: 'IGSID_123' },
      sender_action: 'mark_seen',
    });
  });
});

// ---------------------------------------------------------------------------
// Fix 6/7 — Instagram media
// ---------------------------------------------------------------------------

describe('meta conformance — Instagram media', () => {
  it('sendMedia maps document to file attachment type', async () => {
    const harness = new ApiHarness();
    const client = new InstagramClient(IG_CONFIG);
    harness.bind(client);

    await client.sendMedia('IGSID_1', {
      type: 'document',
      mimeType: 'application/pdf',
      data: 'https://cdn.example.com/doc.pdf',
    });

    const body = harness.calls[0]?.body as { message?: { attachment?: { type?: string } } };
    expect(body.message?.attachment?.type).toBe('file');
  });

  it('uploadMedia throws unsupported', async () => {
    const client = new InstagramClient(IG_CONFIG);
    await expect(client.uploadMedia(Buffer.from('x'), { mimeType: 'image/png' })).rejects.toThrow(
      /not supported/i,
    );
  });

  it('downloadMedia throws unsupported', async () => {
    const client = new InstagramClient(IG_CONFIG);
    await expect(client.downloadMedia('media-id')).rejects.toThrow(/not supported/i);
  });
});

// ---------------------------------------------------------------------------
// Fix 9 — quick_reply payload
// ---------------------------------------------------------------------------

describe('meta conformance — quick reply normalization', () => {
  it('surfaces Messenger quick_reply payload as postback/button', () => {
    const payload = {
      object: 'page',
      entry: [
        {
          id: 'PAGE_ID',
          messaging: [
            {
              sender: { id: 'USER1' },
              timestamp: 123,
              message: {
                mid: 'mid.qr1',
                text: 'Blue',
                quick_reply: { payload: 'COLOR_BLUE' },
              },
            },
          ],
        },
      ],
    };

    const result = normalizeWebhook(payload);
    expect(result.messages[0]?.type).toBe('postback');
    expect(result.messages[0]?.button).toEqual({ text: 'Blue', payload: 'COLOR_BLUE' });
  });
});

// ---------------------------------------------------------------------------
// Fix 10 — ice breakers get parse
// ---------------------------------------------------------------------------

describe('meta conformance — ice breakers get', () => {
  it('parses call_to_actions from messenger_profile response', async () => {
    const client = new InstagramClient(IG_CONFIG);
    Object.assign((client as unknown as { graphApi: GraphAPIClient }).graphApi, {
      get: async () => ({
        data: [
          {
            call_to_actions: [{ question: 'Hours?', payload: 'HOURS' }],
            locale: 'en_US',
          },
        ],
      }),
    });

    const breakers = await client.iceBreakers.get();
    expect(breakers).toEqual([
      { call_to_actions: [{ question: 'Hours?', payload: 'HOURS' }], locale: 'en_US' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Fix 11 — default Graph version v24.0
// ---------------------------------------------------------------------------

describe('meta conformance — default api version', () => {
  it('GraphAPIClient defaults to v24.0', () => {
    const client = new GraphAPIClient({ accessToken: 't', appSecret: 's' });
    expect((client as unknown as { http: { baseUrl?: string } }).http).toBeDefined();
    // Indirect: construct WhatsApp client without apiVersion and verify via internal base URL
    const wa = new WhatsAppClient(WA_CONFIG);
    const http = (wa as unknown as { graphApi: { http: HttpClient } }).graphApi.http;
    expect((http as unknown as { baseUrl: string }).baseUrl).toContain('/v24.0');
  });
});

// ---------------------------------------------------------------------------
// Fix 12 — templates list paging
// ---------------------------------------------------------------------------

describe('meta conformance — templates.list paging', () => {
  it('follows paging.next until exhausted', async () => {
    const client = new WhatsAppClient(WA_CONFIG);
    const endpoints: string[] = [];
    let page = 0;
    Object.assign((client as unknown as { graphApi: GraphAPIClient }).graphApi, {
      get: async (endpoint: string) => {
        endpoints.push(endpoint);
        page++;
        if (page === 1) {
          return {
            data: [
              {
                id: '1',
                name: 'a',
                language: 'en',
                status: 'APPROVED',
                category: 'UTILITY',
                components: [],
              },
            ],
            paging: {
              next: 'https://graph.facebook.com/v24.0/WABA/message_templates?after=cursor1&limit=25',
            },
          };
        }
        return {
          data: [
            {
              id: '2',
              name: 'b',
              language: 'en',
              status: 'APPROVED',
              category: 'UTILITY',
              components: [],
            },
          ],
        };
      },
    });

    const templates = await client.templates.list('WABA');
    expect(templates).toHaveLength(2);
    expect(page).toBe(2);
    expect(endpoints[1]).toBe('WABA/message_templates');
  });
});

// ---------------------------------------------------------------------------
// Fix 14 — classifyMetaError
// ---------------------------------------------------------------------------

describe('meta conformance — classifyMetaError extensions', () => {
  it('maps Messenger 1545041 to WindowClosedError', () => {
    const err = classifyMetaError(400, { error: { code: 1545041, message: 'window' } }, 'messenger');
    expect(err).toBeInstanceOf(WindowClosedError);
  });

  it('maps 551 to person_unavailable', () => {
    const err = classifyMetaError(400, { error: { code: 551, message: 'unavailable' } }, 'messenger');
    expect(err).toBeInstanceOf(MessagingError);
    expect(err.code).toBe('person_unavailable');
  });
});

// ---------------------------------------------------------------------------
// Fix 16 — account-level errors
// ---------------------------------------------------------------------------

describe('meta conformance — webhook account errors', () => {
  it('surfaces value.errors on normalized result', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: '123' },
                errors: [
                  {
                    code: 130429,
                    title: 'Rate limit hit',
                    message: 'Too many messages',
                    error_data: { details: 'Cloud API rate limit' },
                    href: 'https://developers.facebook.com/docs/...',
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = normalizeWebhook(payload);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe(130429);
    expect(result.errors[0]?.error_data?.details).toContain('rate limit');
  });
});

// ---------------------------------------------------------------------------
// Fix 17 — list message row limit
// ---------------------------------------------------------------------------

describe('meta conformance — list message validation', () => {
  it('rejects more than 10 total rows', async () => {
    const client = new WhatsAppClient(WA_CONFIG);
    Object.assign((client as unknown as { graphApi: GraphAPIClient }).graphApi, { post: async () => ({ messages: [{ id: 'x' }] }) });

    await expect(
      client.sendListMessage('5511999999999', {
        body: { text: 'Pick' },
        button: 'Options',
        sections: [
          { title: 'A', rows: Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, title: `A${i}` })) },
          { title: 'B', rows: Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, title: `B${i}` })) },
        ],
      }),
    ).rejects.toThrow(/10 rows/i);
  });
});

// ---------------------------------------------------------------------------
// Fix 18 — flow_token omitted when absent
// ---------------------------------------------------------------------------

describe('meta conformance — flow interactive', () => {
  it('omits flow_token when not provided', async () => {
    const harness = new ApiHarness();
    const client = new WhatsAppClient(WA_CONFIG);
    harness.bind(client);

    await client.sendInteractiveFlow('5511999999999', {
      body: { text: 'Continue' },
      flowId: 'flow-1',
      flowCta: 'Open',
      flowAction: 'navigate',
    });

    const body = harness.calls[0]?.body as {
      interactive?: { action?: { parameters?: Record<string, unknown> } };
    };
    expect(body.interactive?.action?.parameters?.flow_token).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Fix 19 — parseProductInquiry
// ---------------------------------------------------------------------------

describe('meta conformance — parseProductInquiry', () => {
  it('extracts referred_product from raw normalized message', () => {
    const harness = new WhatsAppHarness(WA_CONFIG);
    const inbound = harness.convert({
      id: 'wamid.inq1',
      from: '5511999999999',
      timestamp: '1700000000',
      type: 'text',
      phoneNumberId: WA_CONFIG.phoneNumberId,
      text: { body: 'Is this gluten free?' },
      context: {
        message_id: 'wamid.product1',
        from: '15550001111',
        referred_product: {
          catalog_id: 'cat-1',
          product_retailer_id: 'sku-1',
        },
      },
    });

    const inquiry = parseProductInquiry(inbound);
    expect(inquiry).toEqual({
      catalog_id: 'cat-1',
      product_retailer_id: 'sku-1',
      context_message_id: 'wamid.product1',
      context_from: '15550001111',
    });
  });
});
