import { describe, it, expect } from 'bun:test';
import { createMessagingRouter } from '../src/adapter/createMessagingRouter.js';
import { OutboundPipeline } from '../src/adapter/outbound-pipeline.js';
import { windowGuard } from '../src/adapter/middleware/window-guard.js';
import type { WindowStore } from '../src/adapter/window-store.js';
import type {
  InboundMessage,
  InteractiveMessage,
  MediaPayload,
  PlatformClient,
  SendResult,
} from '../src/types.js';
import type { OutboundRequest, OutboundSink } from '../src/types/outbound.js';
import { createMockRuntime } from '@kuralle-agents/core/testing';
import type { HarnessStreamPart } from '@kuralle-agents/core';

function makeSendResult(threadId = 'thread-1'): SendResult {
  return { messageId: 'mock', threadId, timestamp: new Date() };
}

function createRecordingSink(): OutboundSink & {
  sendTextCalls: number;
  sendMediaCalls: number;
  sendInteractiveCalls: number;
} {
  let sendTextCalls = 0;
  let sendMediaCalls = 0;
  let sendInteractiveCalls = 0;
  return {
    get sendTextCalls() {
      return sendTextCalls;
    },
    get sendMediaCalls() {
      return sendMediaCalls;
    },
    get sendInteractiveCalls() {
      return sendInteractiveCalls;
    },
    sendText: async (to) => {
      sendTextCalls++;
      return makeSendResult(to);
    },
    sendMedia: async (to) => {
      sendMediaCalls++;
      return makeSendResult(to);
    },
    sendInteractive: async (to) => {
      sendInteractiveCalls++;
      return makeSendResult(to);
    },
  };
}

function closedWindowRequest(overrides: Partial<OutboundRequest> = {}): OutboundRequest {
  return {
    threadId: 'thread-1',
    platform: 'whatsapp',
    payload: { kind: 'text', text: 'hello' },
    meta: {
      window: { open: false, expiresAt: null },
      parts: [],
      sessionId: 'sess-1',
    },
    ...overrides,
  };
}

const alwaysClosedWindowStore: WindowStore = {
  get: async () => ({ open: false, expiresAt: null }),
  recordInbound: async () => {},
  recordExpiry: async () => {},
};

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'msg-1',
    platform: 'whatsapp',
    threadId: '1234567890',
    customerId: 'user-1',
    from: { id: 'user-1', name: 'Test User' },
    timestamp: new Date(),
    type: 'text',
    text: 'hello',
    ...overrides,
  };
}

type MockPlatform = PlatformClient & {
  _messageHandlers: Array<(message: InboundMessage, raw: unknown) => Promise<void>>;
};

function createMockPlatform(options?: {
  onSendText?: () => Promise<SendResult>;
}): MockPlatform {
  const messageHandlers: Array<(message: InboundMessage, raw: unknown) => Promise<void>> = [];
  let sendTextCalls = 0;
  return {
    platform: 'mock',
    handleWebhook: async () => new Response('OK', { status: 200 }),
    onMessage: (h) => messageHandlers.push(h),
    onStatus: () => {},
    onReaction: () => {},
    sendText: async () => {
      sendTextCalls++;
      return options?.onSendText ? options.onSendText() : makeSendResult();
    },
    sendMedia: async () => makeSendResult(),
    sendInteractive: async () => makeSendResult(),
    sendRaw: async () => makeSendResult(),
    markAsRead: async () => {},
    sendTypingIndicator: async () => {},
    uploadMedia: async () => ({ mediaId: 'mock' }),
    downloadMedia: async () => ({ data: Buffer.from(''), mimeType: 'text/plain' }),
    formatConverter: {
      toPlainText: (t: string) => t,
      toMarkdown: (t: string) => t,
      toPlatformFormat: (t: string) => t,
    },
    webhookRouter: () => {
      throw new Error('not implemented');
    },
    _messageHandlers: messageHandlers,
    get _sendTextCalls() {
      return sendTextCalls;
    },
  } as MockPlatform & { _sendTextCalls: number };
}

async function* textStream(text: string): AsyncGenerator<HarnessStreamPart> {
  yield { type: 'text-delta' as const, text };
}

describe('windowGuard', () => {
  it('window_closed_blocks_freeform', async () => {
    const sink = createRecordingSink();
    const pipeline = new OutboundPipeline([windowGuard], sink);
    const outcome = await pipeline.send(closedWindowRequest());

    expect(outcome).toEqual({ kind: 'deferred', reason: 'window-closed' });
    expect(sink.sendTextCalls).toBe(0);
  });

  it('window_closed_blocks_media_and_interactive', async () => {
    const sink = createRecordingSink();
    const pipeline = new OutboundPipeline([windowGuard], sink);

    const media: MediaPayload = {
      type: 'image',
      data: 'https://example.com/a.png',
      mimeType: 'image/png',
    };
    const interactive: InteractiveMessage = {
      type: 'buttons',
      body: 'Pick',
      action: {
        type: 'buttons',
        buttons: [{ id: '1', title: 'A' }],
      },
    };

    const mediaOutcome = await pipeline.send(
      closedWindowRequest({ payload: { kind: 'media', media } }),
    );
    const interactiveOutcome = await pipeline.send(
      closedWindowRequest({ payload: { kind: 'interactive', interactive } }),
    );

    expect(mediaOutcome.kind).toBe('deferred');
    expect(interactiveOutcome.kind).toBe('deferred');
    expect(sink.sendMediaCalls).toBe(0);
    expect(sink.sendInteractiveCalls).toBe(0);
  });

  it('passes templates when window is closed', async () => {
    const sink = createRecordingSink();
    sink.sendTemplate = async (to) => {
      return makeSendResult(to);
    };
    const pipeline = new OutboundPipeline([windowGuard], sink);

    const outcome = await pipeline.send(
      closedWindowRequest({
        payload: {
          kind: 'template',
          template: { name: 'hello', language: 'en' },
        },
      }),
    );

    expect(outcome.kind).toBe('sent');
  });

  it('passes free-form when window is open', async () => {
    const sink = createRecordingSink();
    const pipeline = new OutboundPipeline([windowGuard], sink);
    const outcome = await pipeline.send({
      ...closedWindowRequest(),
      meta: {
        window: { open: true, expiresAt: new Date(Date.now() + 86_400_000) },
        parts: [],
        sessionId: 'sess-1',
      },
    });

    expect(outcome.kind).toBe('sent');
    expect(sink.sendTextCalls).toBe(1);
  });
});

describe('router pipeline integration', () => {
  it('fallback_and_custom_mapper_route_through_pipeline', async () => {
    const platform = createMockPlatform();
    const sendTextCalls = () => (platform as MockPlatform & { _sendTextCalls: number })._sendTextCalls;

    const runtimeThrows = createMockRuntime(() => {
      throw new Error('runtime exploded');
    });

    createMessagingRouter({
      runtime: runtimeThrows,
      platforms: { mock: platform },
      windowStore: alwaysClosedWindowStore,
      fallbackMessage: 'fallback text',
    });

    const handler = platform._messageHandlers[0]!;
    await handler(makeMessage({ id: 'fallback-closed-1' }), {});
    expect(sendTextCalls()).toBe(0);

    let mapperSendTextCalls = 0;
    const platform2 = createMockPlatform({
      onSendText: async () => {
        mapperSendTextCalls++;
        return makeSendResult();
      },
    });

    const customMapper = {
      mapResponse: async (
        _parts: HarnessStreamPart[],
        ctx: { sendText: (text: string) => Promise<SendResult> },
      ) => {
        await ctx.sendText('from custom mapper');
      },
    };

    const runtimeOk = createMockRuntime(textStream('hi'));

    createMessagingRouter({
      runtime: runtimeOk,
      platforms: { mock: platform2 },
      windowStore: alwaysClosedWindowStore,
      responseMapper: customMapper,
    });

    const handler2 = platform2._messageHandlers[0]!;
    await handler2(makeMessage({ id: 'mapper-closed-1' }), {});
    expect(mapperSendTextCalls).toBe(0);
  });

  it('open-window reply still reaches the client', async () => {
    let sendTextCalls = 0;
    const platform = createMockPlatform({
      onSendText: async () => {
        sendTextCalls++;
        return makeSendResult();
      },
    });

    const runtime = createMockRuntime(textStream('hello back'));

    createMessagingRouter({
      runtime,
      platforms: { mock: platform },
    });

    const handler = platform._messageHandlers[0]!;
    await handler(makeMessage({ id: 'open-window-1' }), {});
    expect(sendTextCalls).toBeGreaterThanOrEqual(1);
  });
});
