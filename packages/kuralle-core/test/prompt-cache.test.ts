/**
 * Tests for PR-14: Anthropic prompt caching (system_and_3).
 *
 * Validates the cache-control marker placement + provider detection.
 * The actual cost savings happen on the Anthropic side — we just need
 * to be sure kuralle injects the right shape and respects the
 * provider check so non-Anthropic models don't get noise.
 *
 * Reference: AI SDK v6 docs
 * (https://github.com/vercel/ai/blob/ai@6.0.0-beta.128/content/providers/01-ai-sdk-providers/05-anthropic.mdx)
 * — cache_control via `providerOptions.anthropic.cacheControl`.
 */
import { describe, expect, it } from 'bun:test';
import type { ModelMessage } from 'ai';
import {
  applyAnthropicCacheControl,
  isAnthropicLanguageModel,
} from '../src/runtime/promptCache.ts';

function getCacheControl(msg: ModelMessage): unknown {
  const opts = (msg as { providerOptions?: { anthropic?: { cacheControl?: unknown } } })
    .providerOptions;
  return opts?.anthropic?.cacheControl;
}

type ProviderOptionsShape = {
  openai?: { reasoningEffort?: string };
  anthropic?: { someOther?: string; cacheControl?: unknown };
};

function getProviderOptions(msg: ModelMessage): ProviderOptionsShape {
  if (!('providerOptions' in msg) || !msg.providerOptions || typeof msg.providerOptions !== 'object') {
    return {};
  }
  return msg.providerOptions as ProviderOptionsShape;
}

describe('isAnthropicLanguageModel', () => {
  it('matches direct Anthropic provider', () => {
    expect(isAnthropicLanguageModel({ provider: 'anthropic', modelId: 'claude-3-5-sonnet' })).toBe(true);
  });

  it('matches modelId starting with "claude"', () => {
    expect(isAnthropicLanguageModel({ modelId: 'claude-sonnet-4-5' })).toBe(true);
  });

  it('matches OpenRouter-style modelId ("anthropic/claude-…")', () => {
    expect(isAnthropicLanguageModel({ modelId: 'anthropic/claude-3-5-sonnet' })).toBe(true);
  });

  it('matches Vertex Anthropic ("…claude-…")', () => {
    expect(isAnthropicLanguageModel({ modelId: 'vertex-claude-3-5-sonnet-v2@20241022' })).toBe(true);
  });

  it('does NOT match OpenAI', () => {
    expect(isAnthropicLanguageModel({ provider: 'openai', modelId: 'gpt-4.1-mini' })).toBe(false);
  });

  it('does NOT match Gemini', () => {
    expect(isAnthropicLanguageModel({ provider: 'google', modelId: 'gemini-2.0-flash' })).toBe(false);
  });

  it('returns false for null/undefined/non-object inputs', () => {
    expect(isAnthropicLanguageModel(null)).toBe(false);
    expect(isAnthropicLanguageModel(undefined)).toBe(false);
    expect(isAnthropicLanguageModel('claude-3')).toBe(false);
  });
});

describe('applyAnthropicCacheControl — system_and_3 layout', () => {
  it('applies ephemeral cacheControl to the system message + last 3 non-system', () => {
    const msgs: ModelMessage[] = [
      { role: 'system', content: 'sys' } as ModelMessage,
      { role: 'user', content: 'u1' } as ModelMessage,
      { role: 'assistant', content: 'a1' } as ModelMessage,
      { role: 'user', content: 'u2' } as ModelMessage,
      { role: 'assistant', content: 'a2' } as ModelMessage,
      { role: 'user', content: 'u3' } as ModelMessage,
    ];
    const out = applyAnthropicCacheControl(msgs);

    expect(getCacheControl(out[0])).toEqual({ type: 'ephemeral' }); // system
    // First (oldest in window) non-system DOESN'T get a breakpoint —
    // we kept the system slot + the LAST 3 non-system.
    expect(getCacheControl(out[1])).toBeUndefined();
    expect(getCacheControl(out[2])).toBeUndefined();
    // Last 3 non-system: positions 3, 4, 5
    expect(getCacheControl(out[3])).toEqual({ type: 'ephemeral' });
    expect(getCacheControl(out[4])).toEqual({ type: 'ephemeral' });
    expect(getCacheControl(out[5])).toEqual({ type: 'ephemeral' });
  });

  it('handles ttl=1h', () => {
    const msgs: ModelMessage[] = [
      { role: 'system', content: 'sys' } as ModelMessage,
      { role: 'user', content: 'u1' } as ModelMessage,
    ];
    const out = applyAnthropicCacheControl(msgs, '1h');
    expect(getCacheControl(out[0])).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(getCacheControl(out[1])).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('when no system message: applies to last 3 non-system only', () => {
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'u1' } as ModelMessage,
      { role: 'assistant', content: 'a1' } as ModelMessage,
      { role: 'user', content: 'u2' } as ModelMessage,
      { role: 'assistant', content: 'a2' } as ModelMessage,
      { role: 'user', content: 'u3' } as ModelMessage,
    ];
    const out = applyAnthropicCacheControl(msgs);
    // All 4 non-system: only the LAST 4 get markers (we have remaining=4 budget)
    expect(getCacheControl(out[0])).toBeUndefined();
    expect(getCacheControl(out[1])).toEqual({ type: 'ephemeral' });
    expect(getCacheControl(out[2])).toEqual({ type: 'ephemeral' });
    expect(getCacheControl(out[3])).toEqual({ type: 'ephemeral' });
    expect(getCacheControl(out[4])).toEqual({ type: 'ephemeral' });
  });

  it('when fewer than 3 messages: marks all of them', () => {
    const msgs: ModelMessage[] = [
      { role: 'system', content: 'sys' } as ModelMessage,
      { role: 'user', content: 'u1' } as ModelMessage,
    ];
    const out = applyAnthropicCacheControl(msgs);
    expect(getCacheControl(out[0])).toEqual({ type: 'ephemeral' });
    expect(getCacheControl(out[1])).toEqual({ type: 'ephemeral' });
  });

  it('does NOT mutate the input messages', () => {
    const msgs: ModelMessage[] = [
      { role: 'system', content: 'sys' } as ModelMessage,
      { role: 'user', content: 'u1' } as ModelMessage,
    ];
    const snapshot = JSON.stringify(msgs);
    applyAnthropicCacheControl(msgs);
    expect(JSON.stringify(msgs)).toBe(snapshot);
  });

  it('preserves existing providerOptions on a message', () => {
    const msgs: ModelMessage[] = [
      {
        role: 'user',
        content: 'u',
        providerOptions: {
          openai: { reasoningEffort: 'high' },
          anthropic: { someOther: 'thing' },
        },
      } satisfies ModelMessage,
    ];
    const out = applyAnthropicCacheControl(msgs);
    const opts = getProviderOptions(out[0]);
    expect(opts.openai).toEqual({ reasoningEffort: 'high' });
    expect(opts.anthropic?.someOther).toBe('thing');
    expect(opts.anthropic?.cacheControl).toEqual({ type: 'ephemeral' });
  });

  it('empty input returns unchanged', () => {
    expect(applyAnthropicCacheControl([])).toEqual([]);
  });
});
