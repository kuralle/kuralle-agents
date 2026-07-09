import { describe, it, expect, beforeEach } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { ChoiceOption, HarnessStreamPart, Runtime } from '@kuralle-agents/core';
import {
  MemoryStore,
  createWakeJobRunner,
  wakeJob,
  type RunOptions,
} from '@kuralle-agents/core';
import { createMockRuntime } from '@kuralle-agents/core/testing';
import {
  createMessagingRouter,
  InMemoryWindowStore,
  OutboundPipeline,
  windowGuard,
  type ResponseMapper,
  type StatusUpdate,
  type WindowStore,
} from '@kuralle-agents/messaging';
import { WhatsAppClient } from '@kuralle-agents/messaging-meta/whatsapp';
import type { WhatsAppClientConfig, TemplateInfo } from '@kuralle-agents/messaging-meta/whatsapp';
import { parseInboundOrder } from '@kuralle-agents/messaging-meta/whatsapp';
import type { Hono } from 'hono';

import {
  engagement,
  sessionConsentStore,
  whatsappPolicy,
  type TemplateSelector,
} from '../src/index.js';

interface CapturedRun {
  sessionId?: string;
  input?: RunOptions['input'];
  selection?: RunOptions['selection'];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APP_SECRET = 'e2e_app_secret';
const VERIFY_TOKEN = 'e2e_verify_token';
const PHONE_NUMBER_ID = '999888777';
const WABA_ID = 'WABA_E2E';
const FROM = '5511999999999';
const THREAD_ID = `whatsapp:${PHONE_NUMBER_ID}:${FROM}`;

const baseConfig: WhatsAppClientConfig = {
  accessToken: 'fake_access_token',
  appSecret: APP_SECRET,
  phoneNumberId: PHONE_NUMBER_ID,
  verifyToken: VERIFY_TOKEN,
};

// ---------------------------------------------------------------------------
// Harness — real WhatsAppClient, fake Graph API transport
// ---------------------------------------------------------------------------

type CapturedPost = { endpoint: string; body: Record<string, unknown> };

class WhatsAppWorkflowHarness extends WhatsAppClient {
  readonly posts: CapturedPost[] = [];
  private mediaBytes = Buffer.from('e2e-image-bytes');

  constructor(config: WhatsAppClientConfig, opts?: { mediaBytes?: Buffer }) {
    super(config);
    if (opts?.mediaBytes) this.mediaBytes = opts.mediaBytes;
    Object.assign(this.graphApi, {
      post: async (endpoint: string, body: unknown) => {
        this.posts.push({ endpoint, body: body as Record<string, unknown> });
        return {
          messaging_product: 'whatsapp',
          contacts: [{ input: FROM, wa_id: FROM }],
          messages: [{ id: 'wamid.out1' }],
        };
      },
      get: async (endpoint: string) => {
        if (endpoint.includes('message_templates')) {
          return { data: [approvedTemplateRow()], paging: undefined };
        }
        return { url: 'https://fake.cdn/media', mime_type: 'image/jpeg', sha256: 'abc', id: endpoint };
      },
      fetchBinary: async () => this.mediaBytes,
    });
  }

  messagePosts(): CapturedPost[] {
    return this.posts.filter((p) => p.endpoint === `${PHONE_NUMBER_ID}/messages`);
  }

  clearPosts(): void {
    this.posts.length = 0;
  }
}

function approvedTemplateRow(): TemplateInfo & { id: string } {
  return {
    id: 'tpl-order',
    name: 'order_reminder',
    language: 'en',
    status: 'APPROVED',
    category: 'UTILITY',
    components: [{ type: 'BODY', text: 'Your {{item}} is ready' }],
    quality: 'GREEN',
  };
}

// ---------------------------------------------------------------------------
// Webhook helpers
// ---------------------------------------------------------------------------

function signBody(body: string): string {
  return 'sha256=' + createHmac('sha256', APP_SECRET).update(body).digest('hex');
}

function nowUnix(): string {
  return String(Math.floor(Date.now() / 1000));
}

async function postWebhook(app: Hono, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  return app.request('/whatsapp/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signBody(body),
    },
    body,
  });
}

const STALE_UNIX = '1700000000';

function textPayload(text: string, msgId = 'wamid.in.text', timestamp = nowUnix()) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA_ID,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: PHONE_NUMBER_ID, display_phone_number: '+1234' },
              contacts: [{ profile: { name: 'E2E User' }, wa_id: FROM }],
              messages: [
                {
                  id: msgId,
                  from: FROM,
                  timestamp,
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

function imagePayload(mediaId = 'media_id_123', msgId = 'wamid.in.img') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA_ID,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: PHONE_NUMBER_ID },
              contacts: [],
              messages: [
                {
                  id: msgId,
                  from: FROM,
                  timestamp: nowUnix(),
                  type: 'image',
                  image: { id: mediaId, mime_type: 'image/jpeg', caption: 'Look!' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function buttonReplyPayload(buttonId: string, title: string, msgId = 'wamid.in.btn') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA_ID,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: PHONE_NUMBER_ID },
              contacts: [],
              messages: [
                {
                  id: msgId,
                  from: FROM,
                  timestamp: nowUnix(),
                  type: 'interactive',
                  interactive: {
                    type: 'button_reply',
                    button_reply: { id: buttonId, title },
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Meta docs order-webhook example (webhook-normalizer.test.ts). */
function orderPayload(msgId = 'wamid.in.order') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550783881', phone_number_id: PHONE_NUMBER_ID },
              contacts: [{ profile: { name: 'Sheena Nelson' }, wa_id: FROM }],
              messages: [
                {
                  from: FROM,
                  id: msgId,
                  timestamp: nowUnix(),
                  type: 'order',
                  order: {
                    catalog_id: '194836987003835',
                    text: 'Love these!',
                    product_items: [
                      { product_retailer_id: 'di9ozbzfi4', quantity: 2, item_price: 30, currency: 'USD' },
                      { product_retailer_id: 'nqryix03ez', quantity: 1, item_price: 25, currency: 'USD' },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function statusPayload(
  status: string,
  opts?: { expirationTimestamp?: string; msgId?: string },
) {
  const statusObj: Record<string, unknown> = {
    id: opts?.msgId ?? `wamid.status.${status}`,
    recipient_id: FROM,
    status,
    timestamp: nowUnix(),
  };
  if (opts?.expirationTimestamp) {
    statusObj.conversation = {
      id: 'conv-e2e',
      expiration_timestamp: opts.expirationTimestamp,
      origin: { type: 'user_initiated' },
    };
  }
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA_ID,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: PHONE_NUMBER_ID },
              statuses: [statusObj],
            },
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

interface RouterBundle {
  app: Hono;
  client: WhatsAppWorkflowHarness;
  windowStore: InMemoryWindowStore;
}

/** Maps stream parts to outbound sends; required for interactive parts (StreamMapper default is text-only). */
const streamResponseMapper: ResponseMapper = {
  async mapResponse(parts, ctx) {
    let text = '';
    for (const part of parts) {
      if (part.type === 'text-delta') text += part.delta;
    }
    if (text.trim()) await ctx.sendText(text);
    for (const part of parts) {
      if (part.type === 'interactive') {
        await ctx.sendInteractive({
          type: 'buttons',
          body: part.prompt,
          action: { type: 'buttons', buttons: [{ id: 'trigger', title: 'trigger' }] },
        });
      }
    }
  },
};

function wrapRuntime(base: Runtime, onRun: (call: CapturedRun) => void): Runtime {
  const run = (opts: RunOptions) => {
    onRun({ sessionId: opts.sessionId, input: opts.input, selection: opts.selection });
    return base.run(opts);
  };
  return { ...base, run, stream: run };
}

function buildRouter(opts: {
  runtime: Runtime;
  windowStore?: InMemoryWindowStore;
  selector?: TemplateSelector;
  consent?: ReturnType<typeof sessionConsentStore>;
  onStatus?: (status: StatusUpdate) => void;
}): RouterBundle {
  const windowStore = opts.windowStore ?? new InMemoryWindowStore();
  const client = new WhatsAppWorkflowHarness(baseConfig);
  const selector: TemplateSelector =
    opts.selector ??
    ({
      async select() {
        return { name: 'order_reminder', language: 'en', params: { item: 'pizza' } };
      },
    } as TemplateSelector);

  const waPolicy = whatsappPolicy({
    client,
    selector,
    windowStore,
    wabaId: WABA_ID,
  });

  const { bridge } = engagement({
    policies: [waPolicy],
    consent: opts.consent,
    windowStore,
  });

  const app = createMessagingRouter({
    runtime: opts.runtime,
    platforms: { whatsapp: client },
    onStatus: opts.onStatus,
    responseMapper: streamResponseMapper,
    ...bridge,
  });

  return { app, client, windowStore };
}

function buildOutboundPipeline(
  client: WhatsAppWorkflowHarness,
  windowStore: WindowStore,
  selector: TemplateSelector,
  consent?: ReturnType<typeof sessionConsentStore>,
) {
  const waPolicy = whatsappPolicy({ client, selector, windowStore, wabaId: WABA_ID });
  const { bridge } = engagement({ policies: [waPolicy], consent, windowStore });
  return new OutboundPipeline([...(bridge.outbound ?? []), windowGuard], client);
}

async function* textStream(text: string): AsyncGenerator<HarnessStreamPart> {
  yield { type: 'text-delta', id: 't', delta: text };
}

const threeChoices: ChoiceOption[] = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Bravo' },
  { id: 'c', label: 'Charlie' },
];

async function* interactiveStream(): AsyncGenerator<HarnessStreamPart> {
  yield {
    type: 'interactive',
    nodeId: 'pick',
    prompt: 'Pick one',
    options: threeChoices,
  };
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

describe('whatsapp_workflow_e2e', () => {
  let msgSeq = 0;
  beforeEach(() => {
    msgSeq = 0;
  });

  function nextMsgId(prefix: string): string {
    return `wamid.${prefix}.${++msgSeq}`;
  }

  it('1_inbound_text_runtime_reply_graph_text_and_window_open', async () => {
    const replyText = 'Thanks for reaching out!';
    const runCalls: CapturedRun[] = [];
    const runtime = wrapRuntime(
      createMockRuntime(textStream(replyText)) as unknown as Runtime,
      (call) => runCalls.push(call),
    );

    const { app, client, windowStore } = buildRouter({ runtime });

    const before = await windowStore.get(THREAD_ID);
    expect(before.open).toBe(false);

    const res = await postWebhook(app, textPayload('Hello agent', nextMsgId('text')));
    expect(res.status).toBe(200);

    const textPosts = client.messagePosts().filter((p) => p.body.type === 'text');
    expect(textPosts).toHaveLength(1);
    expect(textPosts[0]!.body.text).toEqual({ preview_url: false, body: replyText });
    expect(textPosts[0]!.body.messaging_product).toBe('whatsapp');

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]!.input).toBe('Hello agent');

    const after = await windowStore.get(THREAD_ID);
    expect(after.open).toBe(true);
    expect(after.expiresAt).toBeInstanceOf(Date);
  });

  it('2_interactive_round_trip_buttons_then_button_reply_selection', async () => {
    const runCalls: CapturedRun[] = [];
    const runtime = wrapRuntime(
      createMockRuntime(interactiveStream()) as unknown as Runtime,
      (call) => runCalls.push(call),
    );

    const { app, client } = buildRouter({ runtime });

    await postWebhook(app, textPayload('show choices', nextMsgId('choices')));
    const interactivePosts = client.messagePosts().filter((p) => p.body.type === 'interactive');
    expect(interactivePosts).toHaveLength(1);

    const interactive = interactivePosts[0]!.body.interactive as Record<string, unknown>;
    const action = interactive.action as { buttons?: Array<{ id: string; title: string }> };
    expect(action.buttons).toBeDefined();
    expect(action.buttons!.length).toBeLessThanOrEqual(3);
    expect(action.buttons!.length).toBe(3);

    client.clearPosts();
    await postWebhook(app, buttonReplyPayload('b', 'Bravo', nextMsgId('btn')));

    expect(runCalls).toHaveLength(2);
    expect(runCalls[1]!.input).toBe('b');
    expect(runCalls[1]!.selection).toEqual({ id: 'b' });
  });

  it('3_closed_window_freeform_blocked_template_or_deferred', async () => {
    const replyText = 'Closed-window reply';
    const runtime = createMockRuntime(textStream(replyText)) as unknown as Runtime;
    const windowStore = new InMemoryWindowStore();
    await windowStore.recordExpiry(THREAD_ID, new Date('2020-01-01'));

    const matchingSelector: TemplateSelector = {
      async select() {
        return { name: 'order_reminder', language: 'en', params: { item: 'pizza' } };
      },
    };

    const { app: appMatch, client: clientMatch } = buildRouter({
      runtime,
      windowStore,
      selector: matchingSelector,
    });

    await postWebhook(appMatch, textPayload('wake me', nextMsgId('closed1'), STALE_UNIX));
    const templatePosts = clientMatch.messagePosts().filter((p) => p.body.type === 'template');
    const textPosts = clientMatch.messagePosts().filter((p) => p.body.type === 'text');
    expect(templatePosts).toHaveLength(1);
    expect(templatePosts[0]!.body.template).toMatchObject({ name: 'order_reminder' });
    expect(textPosts).toHaveLength(0);

    const runtime2 = createMockRuntime(textStream(replyText)) as unknown as Runtime;
    const windowStore2 = new InMemoryWindowStore();
    await windowStore2.recordExpiry(THREAD_ID, new Date('2020-01-01'));

    const noFitSelector: TemplateSelector = {
      async select() {
        return null;
      },
    };

    const { app: appNoFit, client: clientNoFit } = buildRouter({
      runtime: runtime2,
      windowStore: windowStore2,
      selector: noFitSelector,
    });

    clientNoFit.clearPosts();
    await postWebhook(appNoFit, textPayload('no template', nextMsgId('closed2'), STALE_UNIX));
    expect(clientNoFit.messagePosts()).toHaveLength(0);
  });

  it('4_inbound_image_downloaded_multimodal_runtime_input', async () => {
    const imageBytes = Buffer.from('multimodal-e2e-png-bytes');
    const runCalls: CapturedRun[] = [];
    const runtime = wrapRuntime(
      createMockRuntime(textStream('I see your image')) as unknown as Runtime,
      (call) => runCalls.push(call),
    );

    const windowStore = new InMemoryWindowStore();
    const client = new WhatsAppWorkflowHarness(baseConfig, { mediaBytes: imageBytes });
    const selector: TemplateSelector = { async select() { return null; } };
    const waPolicy = whatsappPolicy({ client, selector, windowStore, wabaId: WABA_ID });
    const { bridge } = engagement({ policies: [waPolicy], windowStore });
    const app = createMessagingRouter({
      runtime,
      platforms: { whatsapp: client },
      responseMapper: streamResponseMapper,
      ...bridge,
    });

    await postWebhook(app, imagePayload('media_id_123', nextMsgId('img')));

    expect(runCalls).toHaveLength(1);
    const input = runCalls[0]!.input;
    expect(Array.isArray(input)).toBe(true);
    const parts = input as Array<{ type: string; text?: string; data?: string; mediaType?: string }>;
    expect(parts.some((p) => p.type === 'text' && p.text === 'Look!')).toBe(true);
    expect(parts.some((p) => p.type === 'file' && p.mediaType === 'image/jpeg')).toBe(true);
    expect(parts.find((p) => p.type === 'file')?.data).toBe(imageBytes.toString('base64'));
  });

  it('5_inbound_order_parseInboundOrder_and_runtime_turn', async () => {
    let capturedOrder: ReturnType<typeof parseInboundOrder>;
    const runCalls: CapturedRun[] = [];

    const runtime = wrapRuntime(
      createMockRuntime(textStream('Order received')) as unknown as Runtime,
      (call) => runCalls.push(call),
    );

    const client = new WhatsAppWorkflowHarness(baseConfig);
    const originalOnMessage = client.onMessage.bind(client);
    client.onMessage = (handler) => {
      originalOnMessage(async (message, raw) => {
        capturedOrder = parseInboundOrder(message);
        await handler(message, raw);
      });
    };

    const windowStore = new InMemoryWindowStore();
    const selector: TemplateSelector = { async select() { return null; } };
    const waPolicy = whatsappPolicy({ client, selector, windowStore, wabaId: WABA_ID });
    const { bridge } = engagement({ policies: [waPolicy], windowStore });
    const app = createMessagingRouter({
      runtime,
      platforms: { whatsapp: client },
      responseMapper: streamResponseMapper,
      ...bridge,
    });

    await postWebhook(app, orderPayload(nextMsgId('order')));

    expect(capturedOrder!).toBeDefined();
    expect(capturedOrder!.catalog_id).toBe('194836987003835');
    expect(capturedOrder!.text).toBe('Love these!');
    expect(capturedOrder!.product_items).toHaveLength(2);

    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]!.input).toBe('Love these!');
  });

  it('6_status_webhook_onStatus_and_window_expiry', async () => {
    const statuses: StatusUpdate[] = [];
    const windowStore = new InMemoryWindowStore();
    const runtime = createMockRuntime(textStream('ok')) as unknown as Runtime;

    const { app, windowStore: store } = buildRouter({
      runtime,
      windowStore,
      onStatus: (s) => statuses.push(s),
    });

    const expiryTs = String(Math.floor(new Date('2099-06-01T00:00:00Z').getTime() / 1000));

    await postWebhook(app, statusPayload('delivered', { expirationTimestamp: expiryTs }));
    await postWebhook(app, statusPayload('read', { msgId: nextMsgId('read') }));

    expect(statuses.map((s) => s.status)).toEqual(['delivered', 'read']);
    expect(statuses[0]!.conversation?.expirationTimestamp).toEqual(
      new Date(parseInt(expiryTs, 10) * 1000),
    );
    expect(statuses[0]!.threadId).toBe(THREAD_ID);

    const window = await store.get(THREAD_ID);
    expect(window.expiresAt).toEqual(new Date(parseInt(expiryTs, 10) * 1000));
  });

  it('7_consent_stop_opts_out_and_blocks_proactive_send', async () => {
    const sessionStore = new MemoryStore();
    const consent = sessionConsentStore(sessionStore, { defaultOptedIn: true });
    const runCalls: CapturedRun[] = [];
    const runtime = wrapRuntime(
      createMockRuntime(textStream('should not run on STOP')) as unknown as Runtime,
      (call) => runCalls.push(call),
    );

    const { app, client, windowStore } = buildRouter({ runtime, consent });

    await postWebhook(app, textPayload('STOP', nextMsgId('stop')));
    expect(await consent.isOptedIn(FROM)).toBe(false);
    expect(runCalls).toHaveLength(0);

    await windowStore.recordInbound(THREAD_ID, new Date());
    client.clearPosts();

    const pipeline = buildOutboundPipeline(client, windowStore, {
      async select() {
        return { name: 'order_reminder', language: 'en', params: { item: 'x' } };
      },
    }, consent);

    const outcome = await pipeline.send({
      threadId: THREAD_ID,
      platform: 'whatsapp',
      payload: { kind: 'text', text: 'proactive promo' },
      meta: {
        window: await windowStore.get(THREAD_ID),
        parts: [],
        sessionId: THREAD_ID,
        userId: FROM,
      },
    });

    expect(outcome).toEqual({ kind: 'deferred', reason: 'not-opted-in' });
    expect(client.messagePosts()).toHaveLength(0);
  });

  it('8_proactive_wake_delivers_through_window_safe_pipeline', async () => {
    const wakeText = 'Following up on your cart!';
    const wakeRuntime = createMockRuntime(textStream(wakeText)) as unknown as Runtime;

    const windowStore = new InMemoryWindowStore();
    await windowStore.recordInbound(THREAD_ID, new Date());

    const client = new WhatsAppWorkflowHarness(baseConfig);
    const selector: TemplateSelector = {
      async select() {
        return { name: 'order_reminder', language: 'en', params: { item: 'cart' } };
      },
    };
    const pipeline = buildOutboundPipeline(client, windowStore, selector);

    const runWake = createWakeJobRunner(wakeRuntime, {
      deliver: async (delivery) => {
        await pipeline.send({
          threadId: THREAD_ID,
          platform: 'whatsapp',
          payload: { kind: 'text', text: delivery.text },
          meta: {
            window: await windowStore.get(THREAD_ID),
            parts: delivery.parts,
            sessionId: delivery.sessionId,
            userId: FROM,
          },
        });
      },
    });

    client.clearPosts();
    await runWake(wakeJob({ sessionId: THREAD_ID, reason: 'cart abandoned' }));

    const textPosts = client.messagePosts().filter((p) => p.body.type === 'text');
    expect(textPosts).toHaveLength(1);
    expect((textPosts[0]!.body.text as { body: string }).body).toBe(wakeText);

    const closedStore = new InMemoryWindowStore();
    await closedStore.recordExpiry(THREAD_ID, new Date('2020-01-01'));
    const clientClosed = new WhatsAppWorkflowHarness(baseConfig);
    const noFitSelector: TemplateSelector = { async select() { return null; } };
    const pipelineClosedNoFit = buildOutboundPipeline(clientClosed, closedStore, noFitSelector);

    const runWakeClosed = createWakeJobRunner(wakeRuntime, {
      deliver: async (delivery) => {
        await pipelineClosedNoFit.send({
          threadId: THREAD_ID,
          platform: 'whatsapp',
          payload: { kind: 'text', text: delivery.text },
          meta: {
            window: await closedStore.get(THREAD_ID),
            parts: delivery.parts,
            sessionId: delivery.sessionId,
            userId: FROM,
          },
        });
      },
    });

    clientClosed.clearPosts();
    await runWakeClosed(wakeJob({ sessionId: THREAD_ID, reason: 'closed window wake' }));
    expect(clientClosed.messagePosts()).toHaveLength(0);
  });
});
