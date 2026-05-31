/**
 * Live OpenAI SDK round-trip against createOpenAICompatRouter + real Kuralle runtime.
 * Run: bun run smoke:openai-compat (from packages/kuralle-hono-server)
 */
import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import OpenAI from 'openai';
import { z } from 'zod';
import { Hono } from 'hono';
import {
  createRuntime,
  defineAgent,
  defineTool,
  MemoryStore,
} from '@kuralle-agents/core';
import { buildToolSet } from '@kuralle-agents/core';
import { createOpenAICompatRouter } from '../src/openaiCompat.ts';
import { liveModel } from '../../kuralle-core/test/helpers/liveModel.js';

config({ path: resolve(import.meta.dir, '../../../.env') });

const lm = liveModel();
const describeLive = lm ? describe : describe.skip;

function startServer(runtime: ReturnType<typeof createRuntime>) {
  const app = new Hono();
  app.route(
    '/',
    createOpenAICompatRouter({
      runtime,
      apiKey: 'test-key',
      clientTools: ['end_call'],
    }),
  );

  const port = 18_700 + Math.floor(Math.random() * 500);
  const server = Bun.serve({ port, fetch: app.fetch });
  const client = new OpenAI({
    baseURL: `http://127.0.0.1:${port}/v1`,
    apiKey: 'test-key',
  });
  return { client, close: () => server.stop(true) };
}

describeLive(`OpenAI compat live SDK round-trip (${lm?.label ?? 'no live key'})`, () => {
  it('streams, preserves session across multi-turn, and surfaces client tool_calls', async () => {
    const model = lm!.model;

    const endCall = defineTool({
      name: 'end_call',
      description: 'End the phone call when the user explicitly wants to hang up or end the call.',
      input: z.object({ reason: z.string().optional() }),
      execute: async () => ({ status: 'pending_client' }),
    });
    const endCallTools = buildToolSet({ end_call: endCall });

    const agent = defineAgent({
      id: 'openai-compat-live',
      name: 'OpenAI Compat Live',
      instructions:
        'You are a concise assistant. Remember facts the user tells you within the conversation. ' +
        'You MUST call the end_call tool (never reply with text only) when the user message contains the exact phrase END CALL NOW.',
      model,
      tools: endCallTools,
      effectTools: { end_call: endCall },
    });

    const sessionStore = new MemoryStore();
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: 'openai-compat-live',
      sessionStore,
      defaultModel: model,
      tools: { end_call: endCall },
    });

    const { client, close } = startServer(runtime);
    const transcript: string[] = [];
    const sessionId = `oai-live-${Date.now()}`;

    try {
      const stream1 = await client.chat.completions.create({
        model: 'openai-compat-live',
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'My favorite color is blue. Reply with exactly: Noted blue.' }],
        metadata: { sessionId },
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming);

      let assistant1 = '';
      let sawUsage = false;
      for await (const chunk of stream1) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) assistant1 += delta;
        if (chunk.usage) sawUsage = true;
      }
      expect(assistant1.length).toBeGreaterThan(0);
      expect(sawUsage).toBe(true);
      transcript.push(`user: My favorite color is blue…`);
      transcript.push(`assistant: ${assistant1}`);

      const stream2 = await client.chat.completions.create({
        model: 'openai-compat-live',
        stream: true,
        messages: [
          { role: 'user', content: 'My favorite color is blue. Reply with exactly: Noted blue.' },
          { role: 'assistant', content: assistant1 },
          { role: 'user', content: 'What is my favorite color? Answer in one short sentence.' },
        ],
        metadata: { sessionId },
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming);

      let assistant2 = '';
      for await (const chunk of stream2) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) assistant2 += delta;
      }
      expect(assistant2.toLowerCase()).toContain('blue');
      transcript.push(`user: What is my favorite color?`);
      transcript.push(`assistant: ${assistant2}`);

      const toolTurn = await client.chat.completions.create({
        model: 'openai-compat-live',
        stream: true,
        messages: [
          ...[
            { role: 'user' as const, content: 'My favorite color is blue. Reply with exactly: Noted blue.' },
            { role: 'assistant' as const, content: assistant1 },
            { role: 'user' as const, content: 'What is my favorite color? Answer in one short sentence.' },
            { role: 'assistant' as const, content: assistant2 },
          ],
          { role: 'user', content: 'END CALL NOW' },
        ],
        metadata: { sessionId },
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming);

      const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
      let currentIndex = -1;
      for await (const chunk of toolTurn) {
        const tcs = chunk.choices[0]?.delta?.tool_calls;
        if (!tcs) continue;
        for (const tc of tcs) {
          const idx = tc.index ?? 0;
          if (!toolCalls[idx]) {
            toolCalls[idx] = { id: tc.id ?? '', name: tc.function?.name ?? '', arguments: '' };
            currentIndex = idx;
          }
          if (tc.id) toolCalls[idx]!.id = tc.id;
          if (tc.function?.name) toolCalls[idx]!.name = tc.function.name;
          if (tc.function?.arguments) toolCalls[idx]!.arguments += tc.function.arguments;
        }
      }

      expect(toolCalls.length).toBeGreaterThan(0);
      expect(toolCalls[0]?.name).toBe('end_call');
      expect(() => JSON.parse(toolCalls[0]!.arguments || '{}')).not.toThrow();
      transcript.push(`user: Thanks, please end the call now.`);
      transcript.push(`assistant tool_calls: ${JSON.stringify(toolCalls)}`);

      const final = await client.chat.completions.create({
        model: 'openai-compat-live',
        stream: false,
        messages: [
          { role: 'user', content: 'My favorite color is blue. Reply with exactly: Noted blue.' },
          { role: 'assistant', content: assistant1 },
          { role: 'user', content: 'What is my favorite color? Answer in one short sentence.' },
          { role: 'assistant', content: assistant2 },
          { role: 'user', content: 'END CALL NOW' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: toolCalls[0]!.id,
                type: 'function',
                function: { name: 'end_call', arguments: toolCalls[0]!.arguments || '{}' },
              },
            ],
          },
          {
            role: 'tool',
            tool_call_id: toolCalls[0]!.id,
            content: JSON.stringify({ status: 'call_ended' }),
          },
          { role: 'user', content: 'Confirm the call has ended in one short sentence.' },
        ],
        metadata: { sessionId },
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);

      const finalText = final.choices[0]?.message?.content ?? '';
      expect(finalText.length).toBeGreaterThan(0);
      transcript.push(`user: Confirm the call has ended…`);
      transcript.push(`assistant: ${finalText}`);

      console.log('[smoke:openai-compat] provider:', lm!.label);
      console.log('[smoke:openai-compat] transcript:\n' + transcript.join('\n'));
    } finally {
      close();
    }
  }, 180_000);
});
