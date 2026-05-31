# Cross-Session Memory

Sessions are scoped to a single conversation. `MemoryService` persists facts, preferences, and context across sessions so agents remember users across conversations.

## The difference: SessionStore vs MemoryService

| | SessionStore | MemoryService |
|--|--------------|--------------|
| Scope | Single session | Across all sessions for a user |
| Content | Messages, working memory, agent states | Facts, summaries, preferences |
| Key | sessionId | userId |
| Lifecycle | Lives as long as the session | Persists indefinitely |

## Setup

```ts
import { Runtime } from '@kuralle-agents/core';
import { InMemoryMemoryService } from '@kuralle-agents/core';

const runtime = new Runtime({
  agents,
  defaultAgentId: 'support',
  memoryService: new InMemoryMemoryService(),
  memoryIngestion: 'onEnd',  // auto-ingest when stream() completes
});
```

**`memoryIngestion` options:**
- `'onEnd'` — automatic after each `stream()` completes. Default for chat.
- `'manual'` — call `memoryService.addSessionToMemory()` yourself.
- `'hook'` — delegate to `onMemoryIngest` hook for compliance branching.

## userId is required

Memory is scoped by `userId`. You must pass it in every `stream()` call:

```ts
for await (const part of runtime.stream({
  input: 'What is my allergy?',
  sessionId: 'session-abc',
  userId: 'user-42',    // ← required for memory to work
})) { ... }
```

If `userId` is missing and `memoryService` is configured, the Runtime logs a warning and skips memory operations. Sessions still work — they just don't get memory.

## What the agent sees

Memories are automatically preloaded as "Context from Past Conversations" in the system prompt before each LLM call:

```
## Context from Past Conversations

[2026-03-10] user: I'm allergic to peanuts.
[2026-03-12] assistant: Booked flight to Paris, no peanut meals.
```

Disable automatic injection per-agent with `preloadMemory: false`.

## Production backends

```ts
// Postgres (multi-instance, persistent)
import { PostgresSessionStore } from '@kuralle-agents/postgres-store';
const runtime = new Runtime({
  agents,
  sessionStore: new PostgresSessionStore({ connectionString: process.env.DATABASE_URL }),
  memoryService: /* postgres memory backend */,
});

// Redis (low-latency, TTL-friendly)
import { RedisStore } from '@kuralle-agents/redis-store';
```

`InMemoryMemoryService` is for development and tests only — data is lost on restart.
