import { describe, it, expect } from 'bun:test';
import { OutboundPipeline } from '../src/adapter/outbound-pipeline.js';
import type {
  OutboundMiddleware,
  OutboundNext,
  OutboundRequest,
  OutboundSink,
  SendOutcome,
} from '../src/types/outbound.js';
function makeSendResult(threadId = 'thread-1') {
  return { messageId: 'msg-out', threadId, timestamp: new Date() };
}

function makeRequest(overrides: Partial<OutboundRequest> = {}): OutboundRequest {
  return {
    threadId: 'thread-1',
    platform: 'whatsapp',
    payload: { kind: 'text', text: 'hello' },
    meta: {
      window: { open: true, expiresAt: new Date(Date.now() + 86_400_000) },
      parts: [],
      sessionId: 'sess-1',
    },
    ...overrides,
  };
}

const windowGuardStub: OutboundMiddleware = {
  name: 'window-guard',
  send: (req, next) => next(req),
};

function createRecordingSink(): OutboundSink & { sendTextCalls: Array<[string, string]> } {
  const sendTextCalls: Array<[string, string]> = [];
  return {
    sendTextCalls,
    sendText: async (to, text) => {
      sendTextCalls.push([to, text]);
      return makeSendResult(to);
    },
    sendInteractive: async (to) => makeSendResult(to),
    sendMedia: async (to) => makeSendResult(to),
  };
}

describe('OutboundPipeline', () => {
  it('pipeline_composes', async () => {
    let passThroughRan = false;
    const passThrough: OutboundMiddleware = {
      name: 'pass-through',
      send: async (req, next: OutboundNext) => {
        passThroughRan = true;
        return next(req);
      },
    };
    const sink = createRecordingSink();
    const pipeline = new OutboundPipeline([passThrough, windowGuardStub], sink);
    const outcome = await pipeline.send(makeRequest());

    expect(passThroughRan).toBe(true);
    expect(sink.sendTextCalls).toEqual([['thread-1', 'hello']]);
    expect(outcome.kind).toBe('sent');
    if (outcome.kind === 'sent') {
      expect(outcome.result.messageId).toBe('msg-out');
      expect(outcome.result.threadId).toBe('thread-1');
    }
  });

  it('window_guard_required', () => {
    const passThrough: OutboundMiddleware = {
      name: 'pass-through',
      send: (req, next) => next(req),
    };
    const sink = createRecordingSink();
    expect(() => new OutboundPipeline([passThrough], sink)).toThrow(
      'window-guard middleware is required (window safety)',
    );
  });

  it('window_guard_terminal', () => {
    const passThrough: OutboundMiddleware = {
      name: 'pass-through',
      send: (req, next) => next(req),
    };
    const sink = createRecordingSink();
    expect(() => new OutboundPipeline([windowGuardStub, passThrough], sink)).toThrow(
      'window-guard must be terminal (the last middleware before the sink)',
    );
  });
});
