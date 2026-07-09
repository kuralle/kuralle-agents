import { describe, expect, it } from 'bun:test';
import { createAgentHandler } from '../src/handler.js';
import { getAgentHandlerTestState } from './handler-test-access.js';

describe('HTTP AgentHandler failure paths', () => {
  it('returns 500 when generateReply throws', async () => {
    const handler = createAgentHandler({
      agent: () => {
        throw new Error('not used');
      },
    });

    const state = getAgentHandlerTestState(handler);
    state.adapters.set('s3', {
      isOpen: true,
      touch: () => {},
      audioInput: { pushAudioBuffer: () => {} },
    });

    state.sessionManager = {
      getSession: () => ({
        generateReply: () => {
          throw new Error('boom');
        },
      }),
      closeSession: async () => {},
      closeAll: async () => {},
    };

    const req = new Request('http://localhost/session?id=s3', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'user_text', text: 'hello' }),
    });

    const res = await handler.handleInput(req);
    expect(res.status).toBe(500);
  });
});
