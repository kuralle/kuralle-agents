import { describe, expect, it } from 'bun:test';
import { createOpenAICompatRouter } from '../src/openaiCompat.ts';
import { mockRuntime, parseOpenAiSse } from './openai-compat.helpers.ts';

describe('OpenAI compat SSE shape', () => {
  it('keeps chatcmpl id and created (seconds) stable; role only in first delta', async () => {
    const app = createOpenAICompatRouter({
      runtime: mockRuntime([
        { type: 'text-delta', text: 'Hello' },
        { type: 'text-delta', text: ' world' },
        { type: 'done', sessionId: 's1' },
      ]),
    });

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(response.status).toBe(200);
    const chunks = await parseOpenAiSse(await response.text());
    const dataChunks = chunks.filter((c) => c !== '[DONE]') as Array<Record<string, unknown>>;

    expect(dataChunks.length).toBeGreaterThan(2);
    expect(chunks[chunks.length - 1]).toBe('[DONE]');

    const ids = new Set(dataChunks.map((c) => c.id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^chatcmpl-/);

    const createdValues = new Set(dataChunks.map((c) => c.created));
    expect(createdValues.size).toBe(1);
    expect(Number([...createdValues][0])).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));

    for (const chunk of dataChunks) {
      expect(chunk.object).toBe('chat.completion.chunk');
      expect(chunk.model).toBe('test-model');
    }

    const roleChunks = dataChunks.filter((c) => {
      const delta = (c.choices as Array<{ delta?: { role?: string } }>)?.[0]?.delta;
      return delta?.role === 'assistant';
    });
    expect(roleChunks.length).toBe(1);

    const contentChunks = dataChunks.filter((c) => {
      const delta = (c.choices as Array<{ delta?: { content?: string } }>)?.[0]?.delta;
      return typeof delta?.content === 'string';
    });
    expect(contentChunks.every((c) => !(c.choices as Array<{ delta?: { role?: string } }>)[0]?.delta?.role)).toBe(
      true,
    );
  });

  it('emits tool_calls with string arguments in fragments and finish_reason tool_calls', async () => {
    const app = createOpenAICompatRouter({
      runtime: mockRuntime([
        { type: 'tool-call', toolName: 'end_call', args: { reason: 'done' }, toolCallId: 'call_abc' },
        { type: 'done', sessionId: 's1' },
      ]),
      clientTools: ['end_call'],
    });

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        stream: true,
        messages: [{ role: 'user', content: 'end the call' }],
      }),
    });

    const chunks = (await parseOpenAiSse(await response.text())).filter(
      (c) => c !== '[DONE]',
    ) as Array<Record<string, unknown>>;

    const toolChunks = chunks.flatMap((c) => {
      const choice = (c.choices as Array<{ delta?: { tool_calls?: unknown[] } }>)?.[0];
      return choice?.delta?.tool_calls ?? [];
    }) as Array<{ index?: number; id?: string; function?: { name?: string; arguments?: unknown } }>;

    expect(toolChunks.length).toBeGreaterThan(1);
    expect(toolChunks[0]?.id).toBe('call_abc');
    expect(toolChunks[0]?.function?.name).toBe('end_call');
    expect(typeof toolChunks[0]?.function?.arguments).not.toBe('object');

    const argFragments = toolChunks
      .slice(1)
      .map((tc) => tc.function?.arguments)
      .filter((v): v is string => typeof v === 'string');
    expect(argFragments.length).toBeGreaterThan(0);
    expect(JSON.parse(argFragments.join(''))).toEqual({ reason: 'done' });

    const finishChunk = chunks.find(
      (c) => (c.choices as Array<{ finish_reason?: string }>)?.[0]?.finish_reason === 'tool_calls',
    );
    expect(finishChunk).toBeTruthy();
  });

  it('emits usage chunk only when stream_options.include_usage is true', async () => {
    const runtime = mockRuntime([
      { type: 'text-delta', text: 'ok' },
      { type: 'done', sessionId: 's1' },
    ]);

    const withoutUsage = await appStream(runtime, false);
    const withUsage = await appStream(runtime, true);

    expect(withoutUsage.some((c) => c.usage !== undefined)).toBe(false);
    expect(withUsage.some((c) => c.usage !== undefined)).toBe(true);
    expect(withUsage.find((c) => c.usage)?.choices).toEqual([]);
  });
});

async function appStream(runtime: ReturnType<typeof mockRuntime>, includeUsage: boolean) {
  const app = createOpenAICompatRouter({ runtime });
  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'test-model',
      stream: true,
      stream_options: { include_usage: includeUsage },
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
  return (await parseOpenAiSse(await response.text())).filter((c) => c !== '[DONE]') as Array<
    Record<string, unknown>
  >;
}
