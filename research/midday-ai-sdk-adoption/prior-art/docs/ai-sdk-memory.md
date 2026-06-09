# Firsthand Inspection: `@ai-sdk-tools/memory`

Inspected from clone at `research/midday-ai-sdk-adoption/prior-art/clones/ai-sdk-tools/packages/memory`.
Repo: `ai-sdk-tools` (Midday-ecosystem tools monorepo). Inspection date 2026-06-09.

## License — VERIFIED: NO LICENSE (adopt-BLOCKED)

- Package `package.json` has **no `license` field** (full file read; only name/version/exports/deps).
- **No `LICENSE` file** in the package dir (`packages/memory/` — confirmed by `cat`: "NO LICENSE FILE in memory pkg").
- **No `LICENSE` file at repo root** either (`cat LICENSE` → "NO ROOT LICENSE FILE"), and the root `package.json` has no `license` field.

Verdict: **No declared license anywhere.** Under default copyright this is "all rights reserved" — **adoption is BLOCKED** unless the upstream author clarifies/relicenses. The flag in the task is confirmed correct.

## What it does

A **persistent working-memory + conversation-history + chat-session store** for AI agents, with a 4-method pluggable provider interface and four bundled backends. It is a thin storage/formatting layer — **not** a retrieval engine.

- **Working memory** = a single **markdown blob** (`{ content: string; updatedAt: Date }`), scoped per-chat or per-user. The agent is told (via injected instructions) to call an `updateWorkingMemory` tool whenever it learns a durable fact; the whole blob is rewritten each time. There is no structured "blocks" model (à la Letta/MemGPT) — it is one free-text markdown document with a suggested template (Key Facts / Current Focus / Preferences).
- **Conversation history** = optional append log of `ConversationMessage` rows (analytics / cross-session context). The README/types are explicit that this does NOT replace the frontend-supplied `messages[]` array.
- **Chat sessions** = optional metadata records (title, timestamps, messageCount) with title-generation and prompt-suggestion config hooks.
- **NO vector / NO embeddings / NO semantic retrieval / NO "blocks".** `grep -rin "vector|embed|cosine|block" src/` → no matches. History retrieval is purely recency-based (`getMessages` with `limit` = last-N).

So on the working/long-term axis: it offers **working memory (mutable markdown) + raw history persistence**. "Long-term" is just durable KV/SQL storage with TTLs, not similarity search.

## API surface (real signatures, from `src/types.ts` + `src/utils.ts`)

Root exports (`src/index.ts`) are **types + format helpers only**; providers are imported from subpaths (`@ai-sdk-tools/memory/redis`, `/upstash`, `/in-memory`, `/drizzle`) to avoid peer-dep conflicts.

Core interface (`src/types.ts:84`):

```ts
interface MemoryProvider {
  getWorkingMemory(p: { chatId?: string; userId?: string; scope: MemoryScope }): Promise<WorkingMemory | null>;
  updateWorkingMemory(p: { chatId?: string; userId?: string; scope: MemoryScope; content: string }): Promise<void>;
  saveMessage?(message: ConversationMessage): Promise<void>;            // optional
  getMessages?<T = UIMessage>(p: { chatId: string; userId?: string; limit?: number }): Promise<T[]>;  // optional
  saveChat?(chat: ChatSession): Promise<void>;                          // optional
  getChats?(p: { userId?: string; search?: string; limit?: number }): Promise<ChatSession[]>;
  getChat?(chatId: string): Promise<ChatSession | null>;
  updateChatTitle?(chatId: string, title: string): Promise<void>;
  deleteChat?(chatId: string): Promise<void>;
}
```

Supporting types:
- `WorkingMemory { content: string; updatedAt: Date }`
- `MemoryScope = "chat" | "user"`
- `ConversationMessage { chatId; userId?; role: "user"|"assistant"|"system"; content: string|unknown; timestamp: Date }`
- `ChatSession { chatId; userId?; title?; createdAt; updatedAt; messageCount }`
- `MemoryConfig { provider; workingMemory?: {enabled; scope; template?}; history?: {enabled; limit?}; chats?: ChatsConfig }`
- `GenerateTitleConfig`, `GenerateSuggestionsConfig` — both hold `model: any` ("Use 'any' to avoid AI SDK dependency").

Format helpers (`src/utils.ts`): `DEFAULT_TEMPLATE`, `formatWorkingMemory(memory)`, `formatHistory(messages, limit=10)`, `getWorkingMemoryInstructions(template)`.

Bundled providers (classes): `InMemoryProvider`, `RedisProvider` (ioredis OR `redis` v4), `UpstashProvider` (`@upstash/redis`), `DrizzleProvider<...>` (Postgres/MySQL/SQLite via drizzle-orm) plus `createWorkingMemoryTable` / `createMessagesTable` schema helpers (`src/providers/drizzle-schema.ts`).

## Core mechanism

1. The agent host injects `getWorkingMemoryInstructions(template)` into the system prompt and auto-exposes an `updateWorkingMemory` tool (per README + `0.1.0` changelog: "Auto-injection of `updateWorkingMemory` tool", "Automatic integration with `@ai-sdk-tools/agents`"). The actual tool wiring lives in the consuming `agents` package, not here.
2. On each relevant turn the model rewrites the **entire** markdown blob; the provider persists it under a key derived from scope (`wm:chat:<chatId>` or `wm:user:<userId>`). Redis/Upstash apply TTLs: **30 days for `user` scope, 24h for `chat` scope** (`redis.ts:354`).
3. History is an append-only list. Redis keeps the **last 100** messages (`rpush` + `ltrim -100 -1`, `redis.ts:377`) with optional configurable TTL. Chat-session listing uses **sorted sets** (`zadd` by `updatedAt`, `zrevrange`) for efficient recency ordering instead of `KEYS`/`SCAN`.
4. `getMessages` reads stored `ConversationMessage`, then tries to `JSON.parse` the `content` field and returns the parsed content directly as `UIMessage` (i.e. it stores serialized AI-SDK UIMessages and round-trips them).
5. Title/suggestion generation is configured here but the LLM call is done by the host (model typed as `any`).

## AI-SDK-native? — NO (decoupled by design)

- `ai` is an **optional peerDependency** (`"ai": "^5.0.0"`, `peerDependenciesMeta.ai.optional: true`).
- **The source never imports `ai`.** `grep -rn "from 'ai'|generateText|generateObject"` over `src/` returns only a comment in `types.ts`. `UIMessage` is deliberately aliased to `any` and `model` fields are `any` "to avoid AI SDK dependency."
- It is AI-SDK-*adjacent* (built to round-trip Vercel AI SDK `UIMessage` JSON and integrate with `@ai-sdk-tools/agents`), but the package itself is provider-agnostic storage with zero hard AI-SDK coupling. Only hard runtime dep is `zod ^4.1.12`; everything else (redis/ioredis/upstash/drizzle/ai) is an optional peer.

## Maintenance signals

- **Version:** `package.json` says `1.2.0`. **CHANGELOG is internally inconsistent** — top two entries are both headed `## 2.0.0` while describing "1.2.0" and "1.1.0" changes (changeset/versioning glitch). Treat the published version as ~1.x, recently churned.
- **Last touched:** repo HEAD is tag `v1.2.0`, commit `a1cc555`, dated **2025-11-21** (monorepo-wide release tag; whole repo moves together).
- **Tests:** **NONE.** No `*.test.*` / `*.spec.*` / `__tests__` in the package (`find` returned nothing). No test script in `package.json` (only `build`/`dev` via tsup). There is `src/examples/drizzle-example.ts` and a `DRIZZLE.md`, but no automated verification.
- **Tooling:** ESM+CJS dual build via tsup, biome for lint/format, zod 4. Depends on sibling `@ai-sdk-tools/debug` for logging.

## Load-bearing verbatim snippets

- `src/types.ts:5` — `export type UIMessage = any; // Users can override with getMessages<UIMessage>`
- `src/types.ts:84-98` — the provider contract:
  ```ts
  export interface MemoryProvider {
    /** Get persistent working memory */
    getWorkingMemory(params: { chatId?: string; userId?: string; scope: MemoryScope; }): Promise<WorkingMemory | null>;
    /** Update persistent working memory */
    updateWorkingMemory(params: { chatId?: string; userId?: string; scope: MemoryScope; content: string; }): Promise<void>;
  ```
- `src/utils.ts:46-52` — working-memory prompt injection (the "long-term memory" mechanism):
  ```ts
  export function getWorkingMemoryInstructions(template: string): string {
    return `
  ## Working Memory
  You have access to persistent working memory that stores user preferences, context, and important facts across conversations.
  **ALWAYS call updateWorkingMemory when:**
  ```
- `src/providers/redis.ts:354` — scope-based TTL (the only "expiry policy"):
  ```ts
  const ttl = params.scope === "user" ? 60 * 60 * 24 * 30 : 60 * 60 * 24;
  ```
- `src/providers/redis.ts:376-377` — history is recency-capped, not retrieved by relevance:
  ```ts
  await this.rpush(key, serialized);
  await this.ltrim(key, -100, -1); // Keep last 100
  ```

## Bottom line for AriaFlow/Kuralle

Useful as a **reference shape** for a `MemoryProvider` interface (clean 4-method core, optional history/chat extensions, KV+SQL backends, AI-SDK-decoupled via `any`). But: (1) **no license → cannot copy/vendor code**; (2) it is **working-memory-as-markdown-blob + recency history**, with **no vector/semantic recall and no structured memory blocks** — so it does not solve long-term retrieval; (3) **zero tests**. Treat as design inspiration only, not an adoptable dependency, until the license is resolved.
