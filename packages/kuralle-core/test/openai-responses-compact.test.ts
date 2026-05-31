/**
 * Tests for PR-14b: OpenAI Responses compact + cache key wiring.
 *
 * Validates the provider detection + the providerOptions builder.
 * The actual server-side effect is on the OpenAI side — we just need
 * to be sure we shape the call correctly and only when the model
 * matches.
 */
import { describe, expect, it } from 'bun:test';
import {
  isOpenAIResponsesModel,
  buildOpenAIResponsesProviderOptions,
} from '../src/runtime/promptCache.ts';

describe('isOpenAIResponsesModel', () => {
  it('matches gpt-4o family', () => {
    expect(isOpenAIResponsesModel({ provider: 'openai', modelId: 'gpt-4o-mini' })).toBe(true);
    expect(isOpenAIResponsesModel({ provider: 'openai', modelId: 'gpt-4o' })).toBe(true);
  });

  it('matches gpt-4.1 family', () => {
    expect(isOpenAIResponsesModel({ provider: 'openai', modelId: 'gpt-4.1-mini' })).toBe(true);
  });

  it('matches gpt-5 family', () => {
    expect(isOpenAIResponsesModel({ provider: 'openai', modelId: 'gpt-5' })).toBe(true);
  });

  it('matches o3 + o4-mini reasoning models', () => {
    expect(isOpenAIResponsesModel({ provider: 'openai', modelId: 'o3-mini' })).toBe(true);
    expect(isOpenAIResponsesModel({ provider: 'openai', modelId: 'o4-mini' })).toBe(true);
  });

  it('matches OpenRouter-style modelId ("openai/gpt-…")', () => {
    expect(isOpenAIResponsesModel({ modelId: 'openai/gpt-4o-mini' })).toBe(true);
  });

  it('does NOT match Claude', () => {
    expect(isOpenAIResponsesModel({ provider: 'anthropic', modelId: 'claude-3-5-sonnet' })).toBe(false);
  });

  it('does NOT match older non-Responses OpenAI models (gpt-3.5-turbo)', () => {
    // Older Chat-Completions-only models don't accept Responses options
    expect(isOpenAIResponsesModel({ provider: 'openai', modelId: 'gpt-3.5-turbo' })).toBe(false);
  });

  it('does NOT match Gemini', () => {
    expect(isOpenAIResponsesModel({ provider: 'google', modelId: 'gemini-2.0-flash' })).toBe(false);
  });

  it('returns false for null/undefined/non-object inputs', () => {
    expect(isOpenAIResponsesModel(null)).toBe(false);
    expect(isOpenAIResponsesModel(undefined)).toBe(false);
    expect(isOpenAIResponsesModel('gpt-4o')).toBe(false);
  });
});

describe('buildOpenAIResponsesProviderOptions', () => {
  it('emits truncation:auto when truncationFallback is "auto"', () => {
    const out = buildOpenAIResponsesProviderOptions({ truncationFallback: 'auto' }, 's-1');
    expect(out).toEqual({ truncation: 'auto' });
  });

  it('does NOT emit truncation when truncationFallback is "disabled"', () => {
    const out = buildOpenAIResponsesProviderOptions({ truncationFallback: 'disabled' }, 's-1');
    expect(out).toBeNull();
  });

  it('does NOT emit truncation when truncationFallback is omitted', () => {
    const out = buildOpenAIResponsesProviderOptions({}, 's-1');
    expect(out).toBeNull();
  });

  it('emits promptCacheKey=sessionId when useSessionAsPromptCacheKey:true', () => {
    const out = buildOpenAIResponsesProviderOptions(
      { useSessionAsPromptCacheKey: true },
      'session-abc-123',
    );
    expect(out).toEqual({ promptCacheKey: 'session-abc-123' });
  });

  it('does NOT emit promptCacheKey when sessionId is empty', () => {
    const out = buildOpenAIResponsesProviderOptions(
      { useSessionAsPromptCacheKey: true },
      '',
    );
    expect(out).toBeNull();
  });

  it('emits BOTH when both opts are set', () => {
    const out = buildOpenAIResponsesProviderOptions(
      { truncationFallback: 'auto', useSessionAsPromptCacheKey: true },
      's-1',
    );
    expect(out).toEqual({ truncation: 'auto', promptCacheKey: 's-1' });
  });
});
