/**
 * Prompt caching — Eve layout (four breakpoints) + path detection.
 *
 * Deliberately replaced the old `system_and_3` contract: a single-string
 * system prompt cannot carry per-message providerOptions, and placing the
 * final breakpoint anywhere but the last message caps hit rate near 50%.
 */
import { describe, expect, it } from 'bun:test';
import type { ModelMessage, SystemModelMessage, ToolSet } from 'ai';
import {
  applyAnthropicCacheControl,
  applyConversationCacheControl,
  applyLastToolCacheBreakpoint,
  applyPromptCache,
  applySystemCacheBreakpoint,
  detectPromptCachePath,
  getAnthropicCacheMarker,
  isAnthropicLanguageModel,
  mergeGatewayAutoCaching,
} from '../src/runtime/promptCache.ts';

const marker = getAnthropicCacheMarker();

function anthropicCache(msg: { providerOptions?: unknown }): unknown {
  const opts = msg.providerOptions as
    | { anthropic?: { cacheControl?: unknown }; bedrock?: { cachePoint?: unknown } }
    | undefined;
  return opts?.anthropic?.cacheControl;
}

function bedrockPoint(msg: { providerOptions?: unknown }): unknown {
  const opts = msg.providerOptions as
    | { anthropic?: { cacheControl?: unknown }; bedrock?: { cachePoint?: unknown } }
    | undefined;
  return opts?.bedrock?.cachePoint;
}

describe('detectPromptCachePath', () => {
  it('returns gateway-auto for any string model id', () => {
    expect(detectPromptCachePath('anthropic/claude-sonnet-4-5')).toEqual({ kind: 'gateway-auto' });
    expect(detectPromptCachePath('bedrock/anthropic.claude-3-5-sonnet')).toEqual({
      kind: 'gateway-auto',
    });
  });

  it('returns anthropic-direct for Anthropic provider instances', () => {
    expect(
      detectPromptCachePath({ provider: 'anthropic.messages', modelId: 'claude-3-5-sonnet' }),
    ).toEqual({ kind: 'anthropic-direct' });
  });

  it('returns anthropic-direct for Bedrock Converse with anthropic model id', () => {
    expect(
      detectPromptCachePath({
        provider: 'amazon-bedrock',
        modelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      }),
    ).toEqual({ kind: 'anthropic-direct' });
  });

  it('returns none for OpenAI / unrelated providers', () => {
    expect(detectPromptCachePath({ provider: 'openai', modelId: 'gpt-4.1-mini' })).toEqual({
      kind: 'none',
    });
    expect(detectPromptCachePath({ provider: 'xai', modelId: 'grok-2' })).toEqual({ kind: 'none' });
  });
});

describe('isAnthropicLanguageModel', () => {
  it('matches anthropic-direct paths only (not gateway strings)', () => {
    expect(isAnthropicLanguageModel({ provider: 'anthropic', modelId: 'claude-3-5-sonnet' })).toBe(
      true,
    );
    expect(isAnthropicLanguageModel('anthropic/claude-3-5-sonnet')).toBe(false);
    expect(isAnthropicLanguageModel({ provider: 'openai', modelId: 'gpt-4.1-mini' })).toBe(false);
    // modelId alone is not enough — Eve gates on provider / bedrock+anthropic id
    expect(isAnthropicLanguageModel({ modelId: 'claude-sonnet-4-5' })).toBe(false);
  });
});

describe('applySystemCacheBreakpoint', () => {
  // Contract changed deliberately. This used to mark the LAST message, on the assumption
  // that callers passed only stable content and appended volatile blocks afterwards.
  // composeSystem now returns [stable head, volatile], so "last" is the volatile message —
  // marking it would cache nothing across a flow transition, which is the ~16-point drop
  // this whole change exists to fix.
  it('marks the STABLE HEAD, leaving the volatile message outside the cached prefix', () => {
    const instructions: SystemModelMessage[] = [
      { role: 'system', content: 'stable-head' },
      { role: 'system', content: 'volatile-node-prompt' },
    ];
    const out = applySystemCacheBreakpoint(instructions, marker);
    expect(anthropicCache(out[0]!)).toEqual({ type: 'ephemeral' });
    expect(bedrockPoint(out[0]!)).toEqual({ type: 'default' });
    expect(anthropicCache(out[1]!)).toBeUndefined();
    expect(instructions[0]!.providerOptions).toBeUndefined();
  });
});

describe('applyLastToolCacheBreakpoint', () => {
  it('marks only the last ToolSet entry', () => {
    const tools = {
      a: { description: 'a', inputSchema: {} },
      b: { description: 'b', inputSchema: {} },
    } as unknown as ToolSet;
    const out = applyLastToolCacheBreakpoint(tools, marker);
    expect((out.a as { providerOptions?: unknown }).providerOptions).toBeUndefined();
    expect(anthropicCache(out.b as { providerOptions?: unknown })).toEqual({ type: 'ephemeral' });
    expect(bedrockPoint(out.b as { providerOptions?: unknown })).toEqual({ type: 'default' });
  });
});

describe('applyConversationCacheControl', () => {
  it('marks the last message regardless of role + the prior assistant', () => {
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: '1', toolName: 't', output: { type: 'text', value: 'r' } }] },
    ];
    const out = applyConversationCacheControl(msgs, marker);
    expect(anthropicCache(out[0]!)).toBeUndefined();
    expect(anthropicCache(out[1]!)).toEqual({ type: 'ephemeral' }); // assistant anchor
    expect(anthropicCache(out[2]!)).toEqual({ type: 'ephemeral' }); // last (tool)
    expect(bedrockPoint(out[2]!)).toEqual({ type: 'default' });
  });

  it('does not mutate input', () => {
    const msgs: ModelMessage[] = [{ role: 'user', content: 'u' }];
    const snap = JSON.stringify(msgs);
    applyConversationCacheControl(msgs, marker);
    expect(JSON.stringify(msgs)).toBe(snap);
  });
});

describe('applyAnthropicCacheControl (compat alias)', () => {
  it('places last-message + assistant-anchor breakpoints (not system_and_3)', () => {
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ];
    const out = applyAnthropicCacheControl(msgs);
    expect(anthropicCache(out[0]!)).toBeUndefined();
    expect(anthropicCache(out[1]!)).toEqual({ type: 'ephemeral' });
    expect(anthropicCache(out[2]!)).toEqual({ type: 'ephemeral' });
  });

  it('supports ttl=1h on the anthropic namespace', () => {
    const out = applyAnthropicCacheControl([{ role: 'user', content: 'u' }], '1h');
    expect(anthropicCache(out[0]!)).toEqual({ type: 'ephemeral', ttl: '1h' });
  });
});

describe('mergeGatewayAutoCaching', () => {
  it('sets gateway.caching=auto without clobbering existing gateway keys', () => {
    const out = mergeGatewayAutoCaching({ gateway: { order: ['anthropic'] } });
    expect(out.gateway).toEqual({ order: ['anthropic'], caching: 'auto' });
  });

  it('preserves an explicit author override on gateway.caching', () => {
    const out = mergeGatewayAutoCaching({ gateway: { caching: false } });
    expect((out.gateway as { caching: unknown }).caching).toBe(false);
  });
});

describe('applyPromptCache (integration)', () => {
  it('anthropic-direct: system breakpoint on stable head, volatile AFTER, tools + conversation marked', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'again' },
    ];
    const tools = {
      lookup: { description: 'look', inputSchema: {} },
    } as unknown as ToolSet;
    const out = applyPromptCache({
      model: { provider: 'anthropic', modelId: 'claude-3-5-sonnet' },
      sessionId: 's1',
      messages,
      tools,
      stableSystem: [{ role: 'system', content: 'STABLE RULES' }],
      volatileSystemBlocks: ['\n## retrieval\nvolatile'],
    });

    expect(out.system).toHaveLength(2);
    expect(out.system![0]!.content).toBe('STABLE RULES');
    expect(anthropicCache(out.system![0]!)).toEqual({ type: 'ephemeral' });
    expect(bedrockPoint(out.system![0]!)).toEqual({ type: 'default' });
    // Volatile must NOT carry the breakpoint — ordering contract
    expect(anthropicCache(out.system![1]!)).toBeUndefined();
    expect(String(out.system![1]!.content)).toContain('volatile');

    expect(anthropicCache(out.tools!.lookup as { providerOptions?: unknown })).toEqual({
      type: 'ephemeral',
    });
    expect(anthropicCache(out.messages.at(-1)!)).toEqual({ type: 'ephemeral' });
    expect(anthropicCache(out.messages[1]!)).toEqual({ type: 'ephemeral' }); // assistant anchor
    expect(out.providerOptions).toBeUndefined();
  });

  it('gateway-auto: sets gateway.caching, never places breakpoints', () => {
    const out = applyPromptCache({
      model: 'anthropic/claude-sonnet-4-5',
      sessionId: 's1',
      messages: [{ role: 'user', content: 'hi' }],
      stableSystem: [{ role: 'system', content: 'sys' }],
      volatileSystemBlocks: ['volatile'],
    });
    expect(out.providerOptions?.gateway).toEqual({ caching: 'auto' });
    expect(anthropicCache(out.system![0]!)).toBeUndefined();
    expect(anthropicCache(out.messages[0]!)).toBeUndefined();
  });

  it('OpenAI Responses: sets promptCacheKey + truncation, no anthropic breakpoints', () => {
    const msgs: ModelMessage[] = [{ role: 'user', content: 'hi' }];
    const out = applyPromptCache({
      model: { provider: 'openai', modelId: 'gpt-4.1-mini' },
      sessionId: 'sess-abc',
      messages: msgs,
      stableSystem: [{ role: 'system', content: 'sys' }],
    });
    // promptCacheKey is now derived from the prefix, not the session — two sessions of the
    // same agent must land in the same cache lane.
    expect(out.providerOptions?.openai?.promptCacheKey).not.toBe('sess-abc');
    expect(String(out.providerOptions?.openai?.promptCacheKey)).toMatch(/^kuralle-[0-9a-f]+$/);
    expect(out.providerOptions?.openai).toMatchObject({
      truncation: 'auto',
    });
    expect(out.messages).toBe(msgs);
    expect(anthropicCache(out.system![0]!)).toBeUndefined();
  });
});

/**
 * Discriminative: if the system breakpoint were applied AFTER appending
 * volatile blocks, this test fails (volatile would carry the marker).
 */
describe('volatile-after-stable ordering (discriminative)', () => {
  it('fails if breakpoint lands on volatile instead of stable', () => {
    const out = applyPromptCache({
      model: { provider: 'anthropic', modelId: 'claude-3-5-sonnet' },
      sessionId: 's',
      messages: [{ role: 'user', content: 'u' }],
      stableSystem: [{ role: 'system', content: 'stable' }],
      volatileSystemBlocks: ['VOLATILE_BLOCK'],
    });
    const stable = out.system![0]!;
    const volatile = out.system![1]!;
    expect(String(volatile.content)).toContain('VOLATILE_BLOCK');
    expect(anthropicCache(stable)).toEqual({ type: 'ephemeral' });
    expect(anthropicCache(volatile)).toBeUndefined();
  });
});
