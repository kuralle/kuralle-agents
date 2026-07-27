// Regression: provider prompt caching must reach streamText with the Eve layout.
// applyPromptCache takes an object (system/tools/messages); TextDriver must pass
// SystemModelMessage[] as `system` and cached tools.
import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { LanguageModel, ModelMessage, SystemModelMessage } from 'ai';
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
  it('Anthropic: applies dual-namespace breakpoints; no openai providerOptions', () => {
    const out = applyPromptCache({
      model: anthropic,
      sessionId: 'sess-1',
      messages: MSGS,
      stableSystem: [{ role: 'system', content: 'sys' }],
      tools: { t: { description: 't', inputSchema: {} } } as never,
    });
    expect(out.providerOptions).toBeUndefined();
    const last = out.messages.at(-1) as {
      providerOptions?: { anthropic?: { cacheControl?: unknown }; bedrock?: { cachePoint?: unknown } };
    };
    expect(last.providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral' });
    expect(last.providerOptions?.bedrock?.cachePoint).toEqual({ type: 'default' });
    expect(
      (out.system![0] as SystemModelMessage).providerOptions?.anthropic,
    ).toEqual({ cacheControl: { type: 'ephemeral' } });
    expect((MSGS.at(-1) as { providerOptions?: unknown }).providerOptions).toBeUndefined();
  });

  // Contract changed deliberately: promptCacheKey is derived from the PREFIX (stable head
  // + tool surface), not the session, so two sessions of the same agent share a cache lane.
  it('OpenAI Responses: sets a prefix-derived promptCacheKey + truncation auto, messages untouched', () => {
    const out = applyPromptCache({
      model: openai,
      sessionId: 'sess-abc',
      messages: MSGS,
    });
    expect(out.messages).toBe(MSGS);
    expect(out.providerOptions?.openai?.truncation).toBe('auto');
    // No stable head and no tools: there is no prefix to key on, so sessionId remains the
    // fallback. Keying on nothing would put every agent in one lane.
    expect(out.providerOptions?.openai?.promptCacheKey).toBe('sess-abc');
  });

  it('OpenAI Responses: keys on the PREFIX once there is a stable head', () => {
    const out = applyPromptCache({
      model: openai,
      sessionId: 'sess-abc',
      messages: MSGS,
      stableSystem: [{ role: 'system', content: 'You are Realm.' }],
    });
    expect(out.providerOptions?.openai?.promptCacheKey).not.toBe('sess-abc');
    expect(String(out.providerOptions?.openai?.promptCacheKey)).toMatch(/^kuralle-[0-9a-f]+$/);

    // A different session with the same prefix lands in the SAME lane — the whole point.
    const other = applyPromptCache({
      model: openai,
      sessionId: 'sess-zzz',
      messages: MSGS,
      stableSystem: [{ role: 'system', content: 'You are Realm.' }],
    });
    expect(other.providerOptions?.openai?.promptCacheKey).toBe(
      out.providerOptions?.openai?.promptCacheKey,
    );
  });

  it('Other providers: untouched (no providerOptions, no message transform)', () => {
    const out = applyPromptCache({
      model: other,
      sessionId: 'sess-1',
      messages: MSGS,
    });
    expect(out.providerOptions).toBeUndefined();
    expect(out.messages).toBe(MSGS);
  });
});

describe('TextDriver wires prompt cache into streamText', () => {
  it('passes openai.promptCacheKey through to the streamText call', async () => {
    let captured:
      | {
          providerOptions?: { openai?: { promptCacheKey?: string } };
          system?: unknown;
        }
      | undefined;
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

    expect(captured?.providerOptions?.openai?.promptCacheKey).not.toBe('sess-xyz');
    expect(String(captured?.providerOptions?.openai?.promptCacheKey)).toMatch(/^kuralle-[0-9a-f]+$/);
    // System must be SystemModelMessage[] (not a bare string) so breakpoints can attach.
    expect(Array.isArray(captured?.system)).toBe(true);
  });

  it('passes Anthropic system as SystemModelMessage[] with cacheControl on the stable head', async () => {
    let captured:
      | {
          system?: Array<{ role: string; content: string; providerOptions?: unknown }>;
          tools?: Record<string, { providerOptions?: unknown }>;
        }
      | undefined;
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

    const agent = defineAgent({
      id: 'a',
      instructions: 'Stable instructions for caching.',
      model: anthropic,
    });
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: 'a',
      defaultModel: anthropic,
      sessionStore: new MemoryStore(),
    });
    const handle = runtime.run({ sessionId: 'sess-anth', input: 'hello' });
    for await (const _ of handle.events) {
      /* drain */
    }
    await handle;

    expect(Array.isArray(captured?.system)).toBe(true);
    const head = captured?.system?.[0];
    expect(head?.role).toBe('system');
    expect(
      (head?.providerOptions as { anthropic?: { cacheControl?: unknown } } | undefined)?.anthropic
        ?.cacheControl,
    ).toEqual({ type: 'ephemeral' });
  });
});

describe('decide nodes are cached', () => {
  it('choiceMatch receives providerOptions instead of paying full price', async () => {
    // Finding 2: choiceMatch fires on every flow transition and had zero applyPromptCache
    // references — uncached, and invisible in the per-turn rate because that only samples
    // the main channel.
    const { applyPromptCache } = await import('../../src/runtime/promptCache.js');
    const out = applyPromptCache({
      model: { provider: 'openai', modelId: 'gpt-4.1-mini' },
      sessionId: 'decide-sess',
      messages: [{ role: 'user', content: 'pick one' }],
      stableSystem: [{ role: 'system', content: 'You are Realm.' }],
    });
    expect(out.providerOptions?.openai?.promptCacheKey).toBeDefined();
    expect(String(out.providerOptions?.openai?.promptCacheKey)).toMatch(/^kuralle-[0-9a-f]+$/);
  });
});
