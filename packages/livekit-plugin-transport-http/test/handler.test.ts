import { describe, expect, it } from 'bun:test';
import { createAgentHandler } from '../src/handler.js';
import { getAgentHandlerTestState } from './handler-test-access.js';

describe('HTTP AgentHandler', () => {
  it('returns 400 on malformed JSON input', async () => {
    const handler = createAgentHandler({
      agent: () => {
        throw new Error('not used');
      },
    });

    getAgentHandlerTestState(handler).adapters.set('s1', {
      isOpen: true,
      touch: () => {},
      audioInput: { pushAudioBuffer: () => {} },
    });

    const req = new Request('http://localhost/session?id=s1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });

    const res = await handler.handleInput(req);
    expect(res.status).toBe(400);
  });

  it('acks user_text once generation is queued', async () => {
    const handler = createAgentHandler({
      agent: () => {
        throw new Error('not used');
      },
    });

    const state = getAgentHandlerTestState(handler);
    state.adapters.set('s2', {
      isOpen: true,
      touch: () => {},
      audioInput: { pushAudioBuffer: () => {} },
    });

    let called = false;
    state.sessionManager = {
      getSession: () => ({
        generateReply: (_opts: unknown) => {
          called = true;
          return { addDoneCallback: () => {} };
        },
      }),
      closeSession: async () => {},
      closeAll: async () => {},
    };

    const req = new Request('http://localhost/session?id=s2', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'user_text', text: 'hello' }),
    });

    const res = await handler.handleInput(req);
    expect(res.status).toBe(200);
    expect(called).toBe(true);
  });
});
