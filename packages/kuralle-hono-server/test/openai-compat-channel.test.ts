import { describe, expect, it } from 'bun:test';
import { createOpenAICompatRouter } from '../src/openaiCompat.ts';
import { mockRuntime, type RecordedRun } from './openai-compat.helpers.ts';

describe('OpenAI compat session mapping', () => {
  it('maps Vapi call.id to vapi- prefixed sessionId', async () => {
    const runs: RecordedRun[] = [];
    const app = createOpenAICompatRouter({
      runtime: mockRuntime(
        [{ type: 'text-delta', text: 'ok' }, { type: 'done', sessionId: 'vapi-call-1' }],
        { onRun: (call) => runs.push(call) },
      ),
    });

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'kuralle',
        messages: [{ role: 'user', content: 'hello' }],
        call: { id: 'call-1' },
      }),
    });

    expect(response.status).toBe(200);
    expect(runs[0]?.sessionId).toBe('vapi-call-1');
  });

  it('sessionKey callback takes priority', async () => {
    const runs: RecordedRun[] = [];
    const app = createOpenAICompatRouter({
      runtime: mockRuntime(
        [{ type: 'text-delta', text: 'ok' }, { type: 'done', sessionId: 'custom-sid' }],
        { onRun: (call) => runs.push(call) },
      ),
      sessionKey: () => 'custom-sid',
    });

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'kuralle',
        messages: [{ role: 'user', content: 'hello' }],
        call: { id: 'call-ignored' },
      }),
    });

    expect(response.status).toBe(200);
    expect(runs[0]?.sessionId).toBe('custom-sid');
  });
});
