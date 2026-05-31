/**
 * Anthropic prompt caching — `system_and_3` layout.
 *
 * Researched against AI SDK v6 docs: cache breakpoints are configured
 * via `providerOptions.anthropic.cacheControl = { type: 'ephemeral' }`
 * at the message OR message-part level. The provider supports up to 4
 * concurrent breakpoints. Cache creation cost is returned in
 * `providerMetadata.anthropic.cacheCreationInputTokens`; cache reads in
 * `cacheReadInputTokens` — both already plumbed through kuralle's
 * \`TokenAccumulator\` via the existing inputTokenDetails wiring.
 *
 * `system_and_3` strategy:
 *   - 1 cache breakpoint on the system message (the largest stable prefix)
 *   - up to 3 breakpoints on the last 3 non-system messages
 *
 * Why these 4 specifically:
 *   - The system prompt is the largest stable prefix and benefits most
 *   - The last 3 non-system messages cover the typical "second turn"
 *     where the model re-reads everything — caching them turns the
 *     ~75% cost reduction on for multi-turn within-session.
 *
 * TTL options: '5m' (Anthropic default) or '1h'. The 1h tier costs more
 * but extends caching across short user idle periods + cross-session
 * within an hour.
 */
import type { ModelMessage } from 'ai';

export type AnthropicCacheTtl = '5m' | '1h';

interface AnthropicCacheControl {
  type: 'ephemeral';
  ttl?: '1h'; // '5m' is implicit when omitted
}

function buildCacheControl(ttl: AnthropicCacheTtl): AnthropicCacheControl {
  return ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
}

/**
 * Returns a SHALLOW-COPIED message list with cache_control markers
 * applied to the system message (if present) + the last 3 non-system
 * messages. Original input is not mutated.
 *
 * When `messages` has no system message, only the last 3 non-system
 * messages get breakpoints. When fewer than 3 non-system messages
 * exist, all of them get breakpoints (Anthropic accepts <4 fine).
 */
export function applyAnthropicCacheControl(
  messages: ModelMessage[],
  ttl: AnthropicCacheTtl = '5m',
): ModelMessage[] {
  if (!messages || messages.length === 0) return messages;
  const cacheControl = buildCacheControl(ttl);

  const result = messages.slice();

  let breakpoints = 0;

  // 1. System message (always the first if present in this list, but
  //    kuralle typically passes the system prompt SEPARATELY to
  //    streamText. This branch only fires when callers put system msgs
  //    inside the messages array — handoff markers, etc.)
  const systemIdx = result.findIndex((m) => m.role === 'system');
  if (systemIdx !== -1) {
    result[systemIdx] = withProviderOptions(result[systemIdx]!, cacheControl);
    breakpoints += 1;
  }

  // 2. Last 3 non-system messages, oldest-first within that window.
  const remaining = 4 - breakpoints;
  const nonSystemIndices: number[] = [];
  for (let i = 0; i < result.length; i++) {
    if (result[i]!.role !== 'system') nonSystemIndices.push(i);
  }
  const lastN = nonSystemIndices.slice(-remaining);
  for (const idx of lastN) {
    result[idx] = withProviderOptions(result[idx]!, cacheControl);
  }

  return result;
}

/**
 * Returns true when the model is an Anthropic Claude model (direct
 * provider, OpenRouter pass-through, or Vertex Anthropic). Used to
 * gate the cache-control wiring — applying it to non-Anthropic
 * providers is a wasted property on the message that other providers
 * ignore but it adds clutter we don't need to ship.
 */
export function isAnthropicLanguageModel(model: unknown): boolean {
  if (!model || typeof model !== 'object') return false;
  const m = model as { provider?: unknown; modelId?: unknown };
  const provider = typeof m.provider === 'string' ? m.provider.toLowerCase() : '';
  const modelId = typeof m.modelId === 'string' ? m.modelId.toLowerCase() : '';
  if (provider.includes('anthropic')) return true;
  if (modelId.startsWith('claude') || modelId.startsWith('anthropic/')) return true;
  if (modelId.includes('claude-')) return true;
  return false;
}

// ── PR-14b: OpenAI Responses compact ────────────────────────────────

/**
 * Detect an OpenAI Responses-API model. The Responses API supports
 * `truncation: 'auto'` (server-side context-overflow safety net) and
 * `promptCacheKey` (per-session cache routing). Both flow through
 * AI SDK v6's `providerOptions.openai`.
 *
 * Matches:
 *   - provider === 'openai' (direct + OpenRouter pass-through "openai/…")
 *   - modelId on the Responses family (gpt-4o, gpt-4.1, gpt-5, o3, o4-mini, etc.)
 *
 * Conservative: when in doubt, returns false (it's safer to skip the
 * provider option than to send a 400-causing field to a non-OpenAI
 * provider).
 */
export function isOpenAIResponsesModel(model: unknown): boolean {
  if (!model || typeof model !== 'object') return false;
  const m = model as { provider?: unknown; modelId?: unknown };
  const provider = typeof m.provider === 'string' ? m.provider.toLowerCase() : '';
  const modelId = typeof m.modelId === 'string' ? m.modelId.toLowerCase() : '';
  if (!provider.includes('openai') && !modelId.startsWith('openai/')) {
    // Non-OpenAI → skip.
    return false;
  }
  // Responses-family Whitelist. Conservative — only the families we
  // know AI SDK routes through the Responses API in v6.
  const stripped = modelId.startsWith('openai/') ? modelId.slice('openai/'.length) : modelId;
  return (
    stripped.startsWith('gpt-4o') ||
    stripped.startsWith('gpt-4.1') ||
    stripped.startsWith('gpt-5') ||
    stripped.startsWith('o3') ||
    stripped.startsWith('o4') ||
    stripped.startsWith('chatgpt-')
  );
}

export interface OpenAIResponsesCompactOptions {
  /**
   * Server-side safety net. With 'auto', when the prompt exceeds the
   * model's context window, the OpenAI Responses API drops items from
   * the beginning of the conversation (silently) instead of throwing
   * a 400. With 'disabled' (default), the request fails — our
   * client-side overflow recovery (PR-1) catches the error and
   * retries.
   *
   * Recommended setup: enable 'auto' on top of our existing client-
   * side compaction. The client path stays the primary strategy
   * (cheaper, observable, controllable); the server fallback covers
   * the rare cases where our compaction is mid-flight or hasn't
   * caught up yet.
   */
  truncationFallback?: 'auto' | 'disabled';
  /**
   * When true, sets `providerOptions.openai.promptCacheKey` to a
   * stable per-session value derived from session.id. OpenAI's
   * automatic prompt-cache (free, >1024 tokens) gets significantly
   * higher hit rates when subsequent turns from the same session
   * route to the same cache slot.
   */
  useSessionAsPromptCacheKey?: boolean;
}

/**
 * Build the provider-options bag for an OpenAI Responses model call.
 * Returns null when the options compile to nothing (caller can skip
 * merging entirely). The session id is required for the cache-key
 * branch but ignored otherwise.
 */
export function buildOpenAIResponsesProviderOptions(
  opts: OpenAIResponsesCompactOptions,
  sessionId: string,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (opts.truncationFallback === 'auto') {
    out.truncation = 'auto';
  }
  if (opts.useSessionAsPromptCacheKey && sessionId) {
    out.promptCacheKey = sessionId;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function withProviderOptions(msg: ModelMessage, cacheControl: AnthropicCacheControl): ModelMessage {
  const existing = msg.providerOptions ?? {};
  const existingAnthropic = existing.anthropic ?? {};
  const cacheControlJson =
    cacheControl.ttl === '1h'
      ? ({ type: 'ephemeral' as const, ttl: '1h' as const })
      : ({ type: 'ephemeral' as const });
  return {
    ...msg,
    providerOptions: {
      ...existing,
      anthropic: {
        ...existingAnthropic,
        cacheControl: cacheControlJson,
      },
    },
  };
}
