/**
 * Provider prompt caching.
 *
 * Anthropic-direct path (Eve layout — four breakpoints, Anthropic's max):
 *   1. Last ToolSet entry — caches tool definitions across turns
 *   2. Last stable SystemModelMessage — caches the system prefix
 *   3. Last conversation message regardless of role — writes newest
 *      content (often a tool result) into the cache on the same request
 *   4. Most recent assistant message before it — automatic cache advance
 *
 * Gateway string models get `gateway.caching = "auto"` and never receive
 * breakpoints. OpenAI Responses models get `promptCacheKey` + truncation.
 *
 * Volatile system blocks (retrieval, memory, run notes) must sit AFTER the
 * stable head so the system breakpoint does not pull them into the cache.
 */
import type { JSONValue, ModelMessage, SystemModelMessage, ToolSet } from 'ai';

export type PromptCachePath =
  | { readonly kind: 'gateway-auto' }
  | { readonly kind: 'anthropic-direct' }
  | { readonly kind: 'none' };

/**
 * Dual-namespace marker: Anthropic Messages API reads `anthropic.cacheControl`;
 * Bedrock Converse reads `bedrock.cachePoint`. Providers ignore foreign namespaces.
 */
export interface AnthropicCacheMarker {
  readonly anthropic: {
    readonly cacheControl: { readonly type: 'ephemeral'; readonly ttl?: '1h' };
  };
  readonly bedrock: {
    readonly cachePoint: { readonly type: 'default' };
  };
}

/** @deprecated Prefer ephemeral default; TTL only applies to anthropic.cacheControl. */
export type AnthropicCacheTtl = '5m' | '1h';

const ANTHROPIC_CACHE_MARKER: AnthropicCacheMarker = Object.freeze({
  anthropic: Object.freeze({
    cacheControl: Object.freeze({ type: 'ephemeral' as const }),
  }),
  bedrock: Object.freeze({
    cachePoint: Object.freeze({ type: 'default' as const }),
  }),
});

const ANTHROPIC_CACHE_MARKER_1H: AnthropicCacheMarker = Object.freeze({
  anthropic: Object.freeze({
    cacheControl: Object.freeze({ type: 'ephemeral' as const, ttl: '1h' as const }),
  }),
  bedrock: Object.freeze({
    cachePoint: Object.freeze({ type: 'default' as const }),
  }),
});

export function detectPromptCachePath(model: unknown): PromptCachePath {
  if (typeof model === 'string') {
    return { kind: 'gateway-auto' };
  }
  if (!model || typeof model !== 'object') {
    return { kind: 'none' };
  }

  const m = model as { provider?: unknown; modelId?: unknown };
  const providerName = typeof m.provider === 'string' ? m.provider.toLowerCase() : '';
  if (providerName.includes('anthropic')) {
    return { kind: 'anthropic-direct' };
  }

  const modelId = typeof m.modelId === 'string' ? m.modelId.toLowerCase() : '';
  if (providerName.includes('bedrock') && modelId.includes('anthropic')) {
    return { kind: 'anthropic-direct' };
  }

  return { kind: 'none' };
}

export function getAnthropicCacheMarker(ttl: AnthropicCacheTtl = '5m'): AnthropicCacheMarker {
  return ttl === '1h' ? ANTHROPIC_CACHE_MARKER_1H : ANTHROPIC_CACHE_MARKER;
}

/**
 * True when breakpoints should be placed (direct Anthropic / Bedrock-Anthropic).
 * String gateway ids are NOT anthropic-direct — they take gateway-auto.
 */
export function isAnthropicLanguageModel(model: unknown): boolean {
  return detectPromptCachePath(model).kind === 'anthropic-direct';
}

export function mergeGatewayAutoCaching(
  base: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
  const baseGateway =
    base?.gateway !== undefined && typeof base.gateway === 'object' && base.gateway !== null
      ? (base.gateway as Record<string, unknown>)
      : undefined;

  return {
    ...base,
    gateway: {
      ...baseGateway,
      caching: baseGateway?.caching ?? 'auto',
    },
  };
}

export function applyLastToolCacheBreakpoint(
  tools: ToolSet,
  marker: AnthropicCacheMarker,
): ToolSet {
  const entries = Object.entries(tools);
  if (entries.length === 0) {
    return tools;
  }

  const result: Record<string, unknown> = {};
  for (let i = 0; i < entries.length; i++) {
    const [name, tool] = entries[i] as [string, Record<string, unknown>];
    if (i === entries.length - 1) {
      const existingProviderOptions =
        tool.providerOptions !== undefined && typeof tool.providerOptions === 'object'
          ? (tool.providerOptions as Record<string, unknown>)
          : undefined;
      result[name] = {
        ...tool,
        providerOptions: {
          ...existingProviderOptions,
          ...marker,
        },
      };
    } else {
      result[name] = tool;
    }
  }

  return result as ToolSet;
}

/**
 * Marks the STABLE HEAD — the first system message — so everything up to and including it
 * is cached.
 *
 * `composeSystem` returns [head, volatile]: the head is base instructions + skills and is
 * byte-identical across turns; the volatile message carries working memory and the flow
 * node prompt, which change every turn by design. Marking the LAST message here would put
 * the breakpoint on the volatile one, caching nothing across a flow transition — that is
 * the bug this exists to prevent, and it cost ~16 points of cache rate (93.20% on a plain
 * session vs 77.20% once a flow entered).
 */
export function applySystemCacheBreakpoint(
  instructions: readonly SystemModelMessage[],
  marker: AnthropicCacheMarker,
): SystemModelMessage[] {
  if (instructions.length === 0) return [...instructions];

  const result = [...instructions];
  const head = result[0]!;
  result[0] = {
    ...head,
    providerOptions: {
      ...head.providerOptions,
      ...marker,
    },
  };
  return result;
}

/**
 * Final breakpoint on the last message (any role) + assistant anchor before it.
 * A lagging final breakpoint caps effective hit rate near 50%.
 */
export function applyConversationCacheControl(
  messages: readonly ModelMessage[],
  marker: AnthropicCacheMarker,
): ModelMessage[] {
  if (messages.length === 0) {
    return [...messages];
  }

  const out = [...messages];

  const mark = (index: number): void => {
    const message = out[index];
    if (message === undefined) return;
    out[index] = {
      ...message,
      providerOptions: {
        ...message.providerOptions,
        ...marker,
      },
    };
  };

  mark(out.length - 1);

  for (let i = out.length - 2; i >= 0; i--) {
    if (out[i]?.role === 'assistant') {
      mark(i);
      break;
    }
  }

  return out;
}

/**
 * @deprecated Use {@link applyConversationCacheControl}. Kept as a named export
 * for existing callers; places the last-message + assistant-anchor breakpoints.
 */
export function applyAnthropicCacheControl(
  messages: ModelMessage[],
  ttl: AnthropicCacheTtl = '5m',
): ModelMessage[] {
  return applyConversationCacheControl(messages, getAnthropicCacheMarker(ttl));
}

export function isOpenAIResponsesModel(model: unknown): boolean {
  if (!model || typeof model !== 'object') return false;
  const m = model as { provider?: unknown; modelId?: unknown };
  const provider = typeof m.provider === 'string' ? m.provider.toLowerCase() : '';
  const modelId = typeof m.modelId === 'string' ? m.modelId.toLowerCase() : '';
  if (!provider.includes('openai') && !modelId.startsWith('openai/')) {
    return false;
  }
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
  truncationFallback?: 'auto' | 'disabled';
  useSessionAsPromptCacheKey?: boolean;
}

/**
 * A cache key derived from the PREFIX, not the session.
 *
 * OpenAI's `prompt_cache_key` is a routing hint: requests sharing a key route to the same
 * cache. Keying it on `sessionId` gave every session its own lane, so two users talking to
 * the same agent — identical instructions, identical tools, therefore an identical cacheable
 * prefix — could never share an entry. The stable head plus the tool surface IS the shared
 * part, so it is what the key is derived from.
 *
 * Tool names are sorted: the same surface declared in a different order is the same prefix.
 */
export function promptCacheKeyFor(
  stableSystem: readonly SystemModelMessage[],
  tools: ToolSet | undefined,
): string {
  const head = stableSystem.map((m) => String(m.content ?? '')).join('\n');
  const toolNames = tools ? Object.keys(tools).sort().join(',') : '';
  const material = `${head}\u0000${toolNames}`;

  // FNV-1a. Not cryptographic — this only needs to be stable and well-distributed, and it
  // must not pull in a hash dependency on the workerd path.
  let hash = 0x811c9dc5;
  for (let i = 0; i < material.length; i += 1) {
    hash ^= material.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `kuralle-${hash.toString(16)}`;
}

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

export function appendVolatileSystemBlocks(
  stable: readonly SystemModelMessage[],
  blocks: Array<string | undefined>,
): SystemModelMessage[] {
  const extras = blocks.filter((block): block is string => Boolean(block?.trim()));
  if (extras.length === 0) {
    return [...stable];
  }
  return [
    ...stable,
    ...extras.map((content) => ({ role: 'system' as const, content })),
  ];
}

export interface ApplyPromptCacheInput {
  model: unknown;
  sessionId: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  /** Stable system prefix (persona, node instructions). Receives the system breakpoint. */
  stableSystem?: SystemModelMessage[];
  /** Volatile blocks appended AFTER the system breakpoint (retrieval, memory, run notes). */
  volatileSystemBlocks?: Array<string | undefined>;
  providerOptions?: Record<string, Record<string, JSONValue>>;
}

export interface ApplyPromptCacheResult {
  messages: ModelMessage[];
  system?: SystemModelMessage[];
  tools?: ToolSet;
  providerOptions?: Record<string, Record<string, JSONValue>>;
}

/**
 * Single wiring point for provider prompt caching. Volatile system blocks are
 * always appended after the stable head — even on non-Anthropic paths — so
 * ordering is a contract of this function, not of call-site accident.
 */
export function applyPromptCache(input: ApplyPromptCacheInput): ApplyPromptCacheResult {
  const {
    model,
    sessionId,
    messages,
    tools,
    stableSystem = [],
    volatileSystemBlocks = [],
    providerOptions: baseProviderOptions,
  } = input;

  const path = detectPromptCachePath(model);
  let outMessages = messages;
  let outTools = tools;
  let outSystem = [...stableSystem];
  let providerOptions: Record<string, Record<string, JSONValue>> | undefined =
    baseProviderOptions ? { ...baseProviderOptions } : undefined;

  if (path.kind === 'gateway-auto') {
    const merged = mergeGatewayAutoCaching(providerOptions);
    providerOptions = merged as Record<string, Record<string, JSONValue>>;
    outSystem = appendVolatileSystemBlocks(outSystem, volatileSystemBlocks);
  } else if (path.kind === 'anthropic-direct') {
    const marker = getAnthropicCacheMarker();
    if (outTools && Object.keys(outTools).length > 0) {
      outTools = applyLastToolCacheBreakpoint(outTools, marker);
    }
    outSystem = applySystemCacheBreakpoint(outSystem, marker);
    outSystem = appendVolatileSystemBlocks(outSystem, volatileSystemBlocks);
    outMessages = applyConversationCacheControl(messages, marker);
  } else {
    outSystem = appendVolatileSystemBlocks(outSystem, volatileSystemBlocks);
  }

  if (isOpenAIResponsesModel(model)) {
    // Key on the PREFIX, not the session — see promptCacheKeyFor. sessionId is kept as the
    // fallback for the degenerate case of no stable head and no tools, where prefix identity
    // carries no information.
    const prefixKey =
      outSystem.length > 0 || (outTools && Object.keys(outTools).length > 0)
        ? promptCacheKeyFor(stableSystem, outTools)
        : sessionId;
    const openai = buildOpenAIResponsesProviderOptions(
      { useSessionAsPromptCacheKey: true, truncationFallback: 'auto' },
      prefixKey,
    );
    if (openai) {
      providerOptions = {
        ...providerOptions,
        openai: {
          ...(providerOptions?.openai ?? {}),
          ...(openai as Record<string, JSONValue>),
        },
      };
    }
  }

  return {
    messages: outMessages,
    system: outSystem.length > 0 ? outSystem : undefined,
    tools: outTools,
    ...(providerOptions ? { providerOptions } : {}),
  };
}
