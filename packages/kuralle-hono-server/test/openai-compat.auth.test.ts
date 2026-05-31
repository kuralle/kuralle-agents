import { describe, expect, it } from 'bun:test';
import { createOpenAICompatRouter } from '../src/openaiCompat.ts';
import { mockRuntime } from './openai-compat.helpers.ts';

describe('OpenAI compat auth', () => {
  const runtime = mockRuntime([
    { type: 'text-delta', text: 'ok' },
    { type: 'done', sessionId: 's1' },
  ]);

  it('returns 401 OpenAI envelope when apiKey configured and Bearer missing', async () => {
    const app = createOpenAICompatRouter({ runtime, apiKey: 'secret-key' });
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { type: string; code?: string } };
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.code).toBe('invalid_api_key');
  });

  it('returns 401 when Bearer token mismatches', async () => {
    const app = createOpenAICompatRouter({ runtime, apiKey: 'secret-key' });
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wrong',
      },
      body: JSON.stringify({
        model: 'test',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(response.status).toBe(401);
  });

  it('accepts matching Bearer token', async () => {
    const app = createOpenAICompatRouter({ runtime, apiKey: 'secret-key' });
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer secret-key',
      },
      body: JSON.stringify({
        model: 'test',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(response.status).toBe(200);
  });
});
