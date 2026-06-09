// Regression: provider prompt caching exists in core but was UNWIRED in 0.7.1
// (zero callers, no `providerOptions` on the speaking-turn `streamText`).
// These tests pin the wiring: `applyPromptCache` gates by provider, and the
// TextDriver actually passes the result into `streamText`.
import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { LanguageModel, ModelMessage } from 'ai';
import { applyPromptCache } from '../../src/runtime/promptCache.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';

const anthropic = { provider: 'anthropic', modelId: 'claude-3-5-sonnet-20241022' } as unknown as LanguageModel;
const openai = { provider: 'openai', modelId: 'gpt-4o-mini' } as unknown as LanguageModel;
const other = { provider: 'xai', modelId: 'grok-2' } as unknown as LanguageModel;
const MSGS: ModelMessage[] = [
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: 'hello' },
  { role: 'user', content: 'again' },
];

afterEach(() => mock.restore());

describe('applyPromptCache (provider gating)', () => {
  it('Anthropic: applies cache_control to messages, no providerOptions', () => {
    const out = applyPromptCache(anthropic, 'sess-1', MSGS);
    expect(out.providerOptions).toBeUndefined();
    const last = out.messages.at(-1) as { providerOptions?: { anthropic?: { cacheControl?: unknown } } };
    expect(last.providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral' });
    // original not mutated
    expect((MSGS.at(-1) as { providerOptions?: unknown }).providerOptions).toBeUndefined();
  });

  it('OpenAI Responses: sets promptCacheKey=sessionId + truncation auto, messages untouched', () => {
    const out = applyPromptCache(openai, 'sess-abc', MSGS);
    expect(out.messages).toBe(MSGS);
    expect(out.providerOptions?.openai).toEqual({ promptCacheKey: 'sess-abc', truncation: 'auto' });
  });

  it('Other providers: untouched (no providerOptions, no message transform)', () => {
    const out = applyPromptCache(other, 'sess-1', MSGS);
    expect(out.providerOptions).toBeUndefined();
    expect(out.messages).toBe(MSGS);
  });
});

describe('TextDriver wires prompt cache into streamText', () => {
  it('passes openai.promptCacheKey through to the streamText call', async () => {
    let captured: { providerOptions?: { openai?: { promptCacheKey?: string } } } | undefined;
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: (opts: typeof captured) => {
          captured = opts;
          return {
            fullStream: (async function* () {
              yield Object.assign({ type: 'text-delta' }, { text: 'hi' });
            })(),
            finishReason: Promise.resolve('stop'),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve([]),
          };
        },
      };
    });

    const agent = defineAgent({ id: 'a', instructions: 'Answer concisely.', model: openai });
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: 'a',
      defaultModel: openai,
      sessionStore: new MemoryStore(),
    });
    const handle = runtime.run({ sessionId: 'sess-xyz', input: 'hello' });
    for await (const _ of handle.events) {
      /* drain */
    }
    await handle;

    expect(captured?.providerOptions?.openai?.promptCacheKey).toBe('sess-xyz');
  });
});
