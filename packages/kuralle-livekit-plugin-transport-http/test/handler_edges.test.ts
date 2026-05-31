import { describe, expect, it } from 'bun:test';
import { initializeLogger } from '@livekit/agents';
import { createAgentHandler } from '../src/handler.js';
import { getAgentHandlerTestState, stubVoiceSession } from './handler-test-access.js';

initializeLogger({ pretty: false, level: 'warn' });

describe('HTTP AgentHandler edge cases', () => {
  it('returns 400 when session id is missing', async () => {
    const handler = createAgentHandler({
      agent: () => {
        throw new Error('unused');
      },
    });

    const req = new Request('http://localhost/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'user_text', text: 'x' }),
    });

    const res = await handler.handleInput(req);
    expect(res.status).toBe(400);
  });

  it('returns 404 when adapter does not exist', async () => {
    const handler = createAgentHandler({
      agent: () => {
        throw new Error('unused');
      },
    });

    const req = new Request('http://localhost/session?id=missing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'user_text', text: 'x' }),
    });

    const res = await handler.handleInput(req);
    expect(res.status).toBe(404);
  });

  it('routes user_audio bytes/sample metadata to adapter input', async () => {
    const handler = createAgentHandler({
      agent: () => {
        throw new Error('unused');
      },
    });

    let captured = { buf: new ArrayBuffer(0), sampleRate: 0, numChannels: 0 };
    let didCapture = false;
    getAgentHandlerTestState(handler).adapters.set('s-audio', {
      isOpen: true,
      touch: () => {},
      audioInput: {
        pushAudioBuffer: (buf: ArrayBuffer, sampleRate: number, numChannels: number) => {
          captured = { buf, sampleRate, numChannels };
          didCapture = true;
        },
      },
    });

    const payload = Buffer.from(Uint8Array.from([1, 2, 3, 4])).toString('base64');
    const req = new Request('http://localhost/session?id=s-audio', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'user_audio',
        audio: payload,
        sampleRate: 16000,
        numChannels: 1,
      }),
    });

    const res = await handler.handleInput(req);
    expect(res.status).toBe(200);
    expect(didCapture).toBe(true);
    expect(captured.sampleRate).toBe(16000);
    expect(captured.numChannels).toBe(1);
    expect(Array.from(new Uint8Array(captured.buf))).toEqual([1, 2, 3, 4]);
  });

  it('handleSSE creates session and returns X-Session-Id', async () => {
    const handler = createAgentHandler({
      agent: stubVoiceSession,
    });

    let startCount = 0;
    getAgentHandlerTestState(handler).sessionManager.startSession = async () => {
      startCount += 1;
      return {};
    };

    const req = new Request('http://localhost/session?id=sse-1');
    const res = await handler.handleSSE(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('X-Session-Id')).toBe('sse-1');
    expect(startCount).toBe(1);
  });

  it('handleSSE reuses existing adapter/session for same id', async () => {
    const handler = createAgentHandler({
      agent: stubVoiceSession,
    });

    let startCount = 0;
    getAgentHandlerTestState(handler).sessionManager.startSession = async () => {
      startCount += 1;
      return {};
    };

    await handler.handleSSE(new Request('http://localhost/session?id=reuse-1'));
    await handler.handleSSE(new Request('http://localhost/session?id=reuse-1'));

    expect(startCount).toBe(1);
  });

  it('handleSSE generates a session id when id query param is missing', async () => {
    const handler = createAgentHandler({
      agent: stubVoiceSession,
    });

    let startCount = 0;
    getAgentHandlerTestState(handler).sessionManager.startSession = async () => {
      startCount += 1;
      return {};
    };

    const res = await handler.handleSSE(new Request('http://localhost/session'));
    const sessionId = res.headers.get('X-Session-Id');

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(sessionId).toBeTruthy();
    expect(startCount).toBe(1);
  });

  it('returns 200 for user_text when session lookup returns null', async () => {
    const handler = createAgentHandler({
      agent: stubVoiceSession,
    });

    const state = getAgentHandlerTestState(handler);
    state.adapters.set('s-no-session', {
      isOpen: true,
      touch: () => {},
      audioInput: { pushAudioBuffer: () => {} },
    });

    state.sessionManager = {
      getSession: () => null,
      closeSession: async () => {},
      closeAll: async () => {},
    };

    const req = new Request('http://localhost/session?id=s-no-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'user_text', text: 'still-ok' }),
    });

    const res = await handler.handleInput(req);
    expect(res.status).toBe(200);
  });

  it('end_session closes and removes adapter for the session', async () => {
    const handler = createAgentHandler({
      agent: stubVoiceSession,
    });

    const state = getAgentHandlerTestState(handler);
    let closedSessionId = '';
    state.sessionManager = {
      getSession: () => null,
      closeSession: async (id: string) => {
        closedSessionId = id;
      },
      closeAll: async () => {},
    };

    state.adapters.set('s-end', {
      isOpen: true,
      touch: () => {},
      audioInput: { pushAudioBuffer: () => {} },
    });

    const req = new Request('http://localhost/session?id=s-end', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'end_session' }),
    });

    const res = await handler.handleInput(req);

    expect(res.status).toBe(200);
    expect(closedSessionId).toBe('s-end');
    expect(state.adapters.has('s-end')).toBe(false);
  });
});
