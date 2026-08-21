import { describe, expect, it } from 'bun:test';
import type { ModelMessage } from 'ai';
import { createOpenAICompatRouter } from '../src/openaiCompat.ts';
import { mockRuntime, type RecordedRun } from './openai-compat.helpers.ts';

describe('OpenAI compat merge mode system prompts', () => {
  it('never forwards role system into seedMessages; maps to callerInstructions instead', async () => {
    const runs: RecordedRun[] = [];
    const app = createOpenAICompatRouter({
      runtime: mockRuntime(
        [{ channel: 'client', type: 'text-delta', payload: { id: 't0', delta: 'ok' } }, { channel: 'client', type: 'done', payload: { sessionId: 'merge-sess' } }],
        { onRun: (call) => runs.push(call) },
      ),
      systemPromptMode: 'merge',
    });

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'kuralle',
        messages: [
          { role: 'system', content: 'You are a voice assistant for Acme Corp.' },
          { role: 'user', content: 'hello' },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const seed = runs[0]?.seedMessages as ModelMessage[] | undefined;
    expect(seed?.some((message) => message.role === 'system') ?? false).toBe(false);
    expect(runs[0]?.callerInstructions).toBe('You are a voice assistant for Acme Corp.');
  });
});
