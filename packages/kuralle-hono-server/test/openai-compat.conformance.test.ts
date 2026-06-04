import { describe, expect, it } from 'bun:test';
import { createOpenAICompatRouter } from '../src/openaiCompat.ts';
import { mockRuntime, parseOpenAiSse, type RecordedRun } from './openai-compat.helpers.ts';

describe('OpenAI compat platform body conformance', () => {
  it('accepts Vapi-shaped body and streams valid OpenAI SSE', async () => {
    const runs: RecordedRun[] = [];
    const app = createOpenAICompatRouter({
      runtime: mockRuntime(
        [
          { type: 'text-delta', id: 't0', delta: 'Hello from Vapi path.' },
          { type: 'done', sessionId: 'vapi-call-99' },
        ],
        { onRun: (call) => runs.push(call) },
      ),
    });

    const response = await app.request('/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'kuralle',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
        call: { id: 'call-99', assistantId: 'asst-1' },
        phoneNumber: { number: '+15551234567' },
        customer: { name: 'Jane' },
        metadata: { sessionId: 'ignored-because-call-id-wins' },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')?.includes('text/event-stream')).toBe(true);

    const chunks = await parseOpenAiSse(await response.text());
    expect(chunks[chunks.length - 1]).toBe('[DONE]');
    expect(runs[0]?.sessionId).toBe('vapi-call-99');

    const content = chunks
      .flatMap((c) => {
        if (typeof c === 'string') return [];
        const delta = (c.choices as Array<{ delta?: { content?: string } }>)?.[0]?.delta;
        return delta?.content ? [delta.content] : [];
      })
      .join('');
    expect(content).toContain('Hello from Vapi');
  });

  it('accepts ElevenLabs-shaped body and derives session from elevenlabs_extra_body.conversation_id', async () => {
    const runs: RecordedRun[] = [];
    const app = createOpenAICompatRouter({
      runtime: mockRuntime(
        [{ type: 'text-delta', id: 't0', delta: 'Hi ElevenLabs.' }, { type: 'done', sessionId: 'el-conv-42' }],
        { onRun: (call) => runs.push(call) },
      ),
    });

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'kuralle',
        stream: true,
        messages: [{ role: 'user', content: 'ping' }],
        elevenlabs_extra_body: { conversation_id: 'conv-42', custom: true },
      }),
    });

    expect(response.status).toBe(200);
    expect(runs[0]?.sessionId).toBe('el-conv-42');
    const chunks = await parseOpenAiSse(await response.text());
    expect(chunks.some((c) => c !== '[DONE]')).toBe(true);
  });

  it('does not surface internal tools; only clientTools appear as tool_calls', async () => {
    const app = createOpenAICompatRouter({
      runtime: mockRuntime([
        { type: 'tool-call', toolName: 'lookup_order', args: { id: '1' }, toolCallId: 'call_int' },
        { type: 'tool-call', toolName: 'end_call', args: { reason: 'done' }, toolCallId: 'call_ext' },
        { type: 'done', sessionId: 's1' },
      ]),
      clientTools: ['end_call'],
    });

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test',
        stream: true,
        messages: [{ role: 'user', content: 'end call' }],
      }),
    });

    const chunks = (await parseOpenAiSse(await response.text())).filter(
      (c) => c !== '[DONE]',
    ) as Array<Record<string, unknown>>;

    const toolNames = chunks.flatMap((c) => {
      const tcs = (c.choices as Array<{ delta?: { tool_calls?: Array<{ function?: { name?: string } }> } }>)?.[0]
        ?.delta?.tool_calls;
      return (tcs ?? []).map((tc) => tc.function?.name).filter(Boolean);
    });

    expect(toolNames).toEqual(['end_call']);
  });
});
