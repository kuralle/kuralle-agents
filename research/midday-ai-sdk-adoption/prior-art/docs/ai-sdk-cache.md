# Firsthand Inspection: `@ai-sdk-tools/cache`

Inspected from the cloned repo at
`research/midday-ai-sdk-adoption/prior-art/clones/ai-sdk-tools/packages/cache`.
Source read verbatim (not README/memory). Repo: `midday-ai/ai-sdk-tools`,
single squashed commit `a1cc555 2025-11-21 "v1.2.0"`.

## License (verified)

- **Declared MIT** in `packages/cache/package.json:16` (`"license": "MIT"`).
- **No `LICENSE` file exists anywhere in the clone** — `find . -iname 'LICENSE*'`
  (excluding `node_modules`) returns nothing, at neither repo root nor the package dir.
- The **root `package.json` has no `license` field at all** (`grep -i license package.json`
  returns empty). So MIT is asserted by the package manifest only; there is no
  accompanying license text to confirm the grant. Treat as "MIT per package.json,
  unaccompanied by license text."

## AI-SDK-native?

**Yes — directly built on the Vercel AI SDK.**
- `peerDependencies: { "ai": "^5.0.82" }` (`package.json:48-50`).
- Imports the AI SDK `Tool` type in `src/types.ts:1`, `src/cache.ts:1`, `src/index.ts:15`
  (`import type { Tool } from "ai"`). The public API is generic over `T extends Tool`.
- Context preservation hooks straight into AI SDK internals: reads
  `executionOptions.experimental_context.writer` and falls back to
  `@ai-sdk-tools/artifacts`'s `getWriter(executionOptions)` (optional peer dep,
  `package.json:51-55`).

## API surface (real signatures)

From `src/index.ts` (public exports: `cached`, `createCached`, `cacheTools`,
types `CacheOptions`, `CachedTool`, re-exported `Tool`):

```ts
// src/cache.ts:317
export function cached<T extends Tool>(tool: T, options?: CacheOptions): CachedTool<T>

// src/cache.ts:573 — pre-bind a store + defaults, returns a cached() factory
export function createCachedFunction(
  store: CacheStore,
  defaultOptions?: Omit<CacheOptions, "store">,
): <T extends Tool>(tool: T, options?: Omit<CacheOptions, "store">) => CachedTool<T>

// src/cache.ts:588 — cache a map of tools with one config
export function cacheTools<T extends Tool, TTools extends Record<string, T>>(
  tools: T, options?: CacheOptions,
): { [K in keyof TTools]: CachedTool<TTools[K]> }

// src/cache.ts:619 — top-level entry; picks Redis vs default LRU
export function createCached(options?: {
  cache?: any;            // user's Redis client, passed through directly
  keyPrefix?: string;
  ttl?: number;
  debug?: boolean;
  cacheKey?: () => string;
  onHit?: (key: string) => void;
  onMiss?: (key: string) => void;
}): ReturnType<typeof createCachedFunction>
```

`CacheOptions` (`src/types.ts:6-33`): `ttl` (default 5min), `maxSize` (default 1000),
`store`, `keyGenerator(params, context?) => string`, `cacheKey() => string` (context
provider), `shouldCache(params, result) => boolean`, `onHit`, `onMiss`, `debug`.

`CachedTool<T>` (`src/types.ts:72-84`) = `T & { getStats(): CacheStats;
clearCache(key?): void; isCached(params): boolean | Promise<boolean>;
getCacheKey(params): string }`.

`CacheStore<T>` (`src/types.ts:90-114`): sync-or-async `get/set/delete/clear/has/size/keys`
+ optional `getDefaultTTL()`. Backends: `LRUCacheStore`, `SimpleCacheStore`
(`src/cache-store.ts`), `MemoryCacheStore`, `RedisCacheStore` (`src/backends/`),
created via `createCacheBackend({type})` (`src/backends/factory.ts:22`).

## Core mechanism

**Two code paths**, chosen by whether the tool's `execute` is an async generator:

1. **Streaming tools** (`execute.constructor.name === "AsyncGeneratorFunction"`,
   `src/cache.ts:322`) → `createStreamingCachedTool` returns a **spread copy** of the
   tool (`{ ...tool, execute: async function*… }`, `src/cache.ts:80-82`) plus cache-API
   methods.
2. **Non-streaming tools** → a **`Proxy`** over the tool (`src/cache.ts:390`) that
   intercepts `get("execute")` and the cache-API props, delegating everything else to
   the target. (This Proxy branch also re-handles a generator `execute` defensively,
   `src/cache.ts:394`.)

On execute: derive key → `cacheStore.get(key)` → if present and
`now - timestamp < ttl`, it's a HIT (replay, below); else MISS → run original
`tool.execute(params, executionOptions)`, stream through, then cache.

Backends are plain TTL-by-timestamp (the entry stores `timestamp`, freshness is
checked on read in `cache.ts`; only `RedisCacheStore.setWithTTL` uses native `setex`,
and that method is **not called** by the main `set` path). LRU evicts oldest Map key
at capacity (`src/cache-store.ts:24-38`).

### Cache key derivation (verbatim, `src/cache.ts:9-54`)

Deterministic, React-Query-style stable serialization. Object keys are **sorted**;
arrays preserve order; Dates → ISO; primitives → `String()`. Optional `context`
(from the `cacheKey()` option) is appended after a `|`.

```ts
function defaultKeyGenerator(params: any, context?: any): string {
  const paramsKey = serializeValue(params);
  if (context) {
    return `${paramsKey}|${context}`;
  }
  return paramsKey;
}

function serializeValue(value: any): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(serializeValue).join(",")}]`;
  if (typeof value === "object") {
    // Sort keys for deterministic serialization (like React Query)
    const sortedKeys = Object.keys(value).sort();
    const pairs = sortedKeys.map((key) => `${key}:${serializeValue(value[key])}`);
    return `{${pairs.join(",")}}`;
  }
  return String(value);
}
```

Note: the key is the raw serialized string (not hashed). The Redis backend prefixes it
(`getKey = keyPrefix + key`, `src/backends/redis.ts:16-18`).

### Context preservation (verbatim — the load-bearing part)

The cache must not swallow side-channel UI events (artifact/writer messages). On a
**MISS**, it monkey-patches `writer.write` to tee every written message into
`capturedMessages` while still forwarding to the real writer
(`src/cache.ts:184-192`). The writer is resolved from the AI SDK execution options,
with a dynamic fallback to `@ai-sdk-tools/artifacts`'s `getWriter`
(`src/cache.ts:170-182`):

```ts
// MISS path — capture writer messages (src/cache.ts:169-192)
let writer =
  executionOptions?.writer ||
  (executionOptions as any)?.experimental_context?.writer;

// Writer comes from AI SDK's experimental_context
if (!writer) {
  try {
    const { getWriter } = await import("@ai-sdk-tools/artifacts");
    writer = getWriter(executionOptions);
  } catch {
    // Artifacts package not available or writer not available
  }
}

const capturedMessages: any[] = [];

if (writer) {
  const originalWrite = writer.write;
  writer.write = (data: any) => {
    capturedMessages.push(data);
    return originalWrite.call(writer, data);
  };
}
```

Captured artifact messages are stored alongside the streamed result. On a **HIT**, they
are **replayed into the live writer first**, then the cached stream yields are emitted —
so a cached tool still emits the same writer/artifact events a fresh run would
(`src/cache.ts:112-152`):

```ts
// HIT path — replay artifact messages, then streaming yields (src/cache.ts:112-152)
// Replay artifact messages first
if (result?.messages?.length > 0) {
  let writer =
    executionOptions?.writer ||
    (executionOptions as any)?.experimental_context?.writer;

  // Writer comes from AI SDK's experimental_context
  if (!writer) {
    try {
      const { getWriter } = await import("@ai-sdk-tools/artifacts");
      writer = getWriter(executionOptions);
    } catch { /* Artifacts package not available or writer not available */ }
  }

  if (writer) {
    for (const msg of result.messages) {
      writer.write(msg);
    }
  }
}

// Replay streaming yields
if (result?.streamResults) {
  for (const item of result.streamResults) {
    yield item;
  }
}
return result.returnValue;
```

What gets cached for a streaming tool (`src/cache.ts:232-237`): **only the final chunk**
of the stream (assumed to carry the full accumulated text), plus all captured writer
`messages`, plus the generator's `returnValue`:

```ts
const completeResult = {
  streamResults: lastChunk ? [lastChunk] : [], // Only final chunk
  messages: capturedMessages,
  returnValue: finalReturnValue,
  type: "streaming",
};
```

Caching is deferred into a double-`queueMicrotask` after the stream finishes so it never
blocks delivery (`src/cache.ts:227-270`), and is gated by `shouldCache(params, result)`.

## Maintenance signals

- **Version:** `1.2.0` (`package.json:3`). CHANGELOG is internally inconsistent — the
  top heading reads `## 2.0.0` while the note says "Release version 1.2.0"
  (`CHANGELOG.md` head), and the published version is 1.2.0.
- **Recency:** the entire clone is a **single commit** `a1cc555`, dated
  **2025-11-21**, message `v1.2.0`. No deeper history is available in this clone.
- **Tests:** **none in this package.** `vitest@^4` is a devDependency
  (`package.json:60`) but `find packages/cache -iname '*.test.*' -o -iname '*.spec.*'`
  returns nothing. There is no `test` script in the package's `package.json`
  (only `build`, `dev`, `clean`, `type-check`). Verification of the cache/replay logic
  rests on `src/examples/*.ts`, not automated tests.
- **Deps:** zero runtime `dependencies`; `ai` is a peer (`^5.0.82`),
  `@ai-sdk-tools/artifacts` an optional peer.

## Notable behaviors / risks (from reading source)

- Cache key is the **raw serialized params string**, un-hashed — large/nested params
  produce large keys; in Redis they become long key names (prefixed only).
- TTL is enforced by **read-time timestamp comparison**, not store-native expiry, on the
  main path (`RedisCacheStore.setWithTTL`/`setex` exists but is unused by `set`), so
  stale entries linger in Redis until read or evicted.
- The writer monkey-patch mutates the caller's `writer.write` in place; it restores
  nothing (no `finally` reset), relying on the writer instance being per-execution.
- Streaming cache stores **only the last chunk** — correctness depends on the tool's
  final yield carrying the complete text. Incremental-only streams would replay
  truncated.
