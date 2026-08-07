# Cross-Session Memory

A session holds one conversation. Memory carries what matters about a **user** across all
of their sessions.

Kuralle has two read paths, and they answer different questions:

| | automatic recall | working-memory blocks |
| --- | --- | --- |
| what it is | extracted values scored against the user's message and injected into the prompt | durable named notes the agent maintains itself |
| who writes it | extractors, after a turn | the model, via the `memory_block` tool |
| who reads it | the runtime, every turn | injected into the prompt; the tool can re-read |
| shape | typed, per extractor (`facts`, your own) | free markdown, per block (`USER`, `MEMORY`) |

Both are configured on the **agent**, under `memory`. Neither is configured on
`createRuntime` — the runtime only supplies the stores.

## Setup

```ts
import { createRuntime, defineAgent, factsExtractor } from '@kuralle-agents/core';
import { FileExtractedValueStore } from '@kuralle-agents/core';

const agent = defineAgent({
  id: 'support',
  model,
  instructions: 'Help the customer.',
  memory: {
    preload: { enabled: true, tokenBudget: 500 },
    extract: [factsExtractor()],
  },
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'support',
  extractedValueStore: new FileExtractedValueStore(),
});
```

`extract` is the write half, `preload` the read half. Configure `extract` without
`preload` and facts accumulate that nothing ever reads back.

## userId is required, and its shape is constrained

Memory is owner-scoped. Pass `userId` on every run:

```ts
const handle = runtime.run({
  input: 'What am I allergic to?',
  sessionId: 'session-abc',
  userId: 'user-42',        // ← without this, user-scoped memory is skipped entirely
});
```

**A session with no `userId` gets no user-scoped memory at all.** It does not fall back to
a shared owner — that was a real cross-user leak, and it now fails closed with a warning.

`userId` must match `^[A-Za-z0-9._@+:~|-]+$`. That accepts what real identity providers
issue — `maya@example.com`, `google-oauth2|123`, `tenant:acme` — and rejects path and glob
characters. An id outside it is refused rather than sanitised: sanitising two different
ids into one string is how two users end up sharing a row. A refused id logs a warning
naming the id, and that session simply runs without memory.

## Writing your own extractor

`factsExtractor()` is a built-in. Define your own for anything typed:

```ts
import { defineExtractor } from '@kuralle-agents/core';
import { z } from 'zod';

const dietaryProfile = defineExtractor({
  name: 'Dietary Profile',
  scope: 'user',
  instructions: 'Allergies and dietary restrictions this person stated about themselves.',
  schema: z.object({
    allergies: z.array(z.string()),
    avoids: z.array(z.string()),
  }),
  // Normalise before persistence rather than hoping the model is consistent.
  onExtracted: ({ current }) => ({
    allergies: [...new Set(current.allergies.map((a) => a.toLowerCase().trim()))].sort(),
    avoids: [...new Set(current.avoids.map((a) => a.toLowerCase().trim()))].sort(),
  }),
});

memory: { extract: [factsExtractor(), dietaryProfile] }
```

Every extractor on an agent runs in **one merged structured call**, not one call each.

## When extraction runs

```ts
memory: {
  extract: [factsExtractor()],
  extraction: {
    trigger: { tokens: 2000 },   // default: after 2000 tokens of un-extracted history
    blocking: false,             // default: do not hold the turn open for it
  },
}
```

`trigger: 'each-turn'` runs it every turn — useful in an example or a test, expensive in
production. `blocking: true` awaits extraction before the run closes; use it when a test
asserts on what was written.

## Working-memory blocks

```ts
import { FilePersistentMemoryStore } from '@kuralle-agents/core';

memory: {
  workingMemory: {
    store: new FilePersistentMemoryStore(),
    autoLoad: [
      { scope: 'user', key: 'USER' },
      { scope: 'agent', key: 'MEMORY' },
    ],
  },
}
```

`autoLoad` is the whole namespace: the `memory_block` tool's `block` argument is a
`z.enum` built from it, so the model can address these and nothing else. An undeclared
block is not rejected at runtime — it cannot be expressed.

`scope: 'user'` is owned by the `userId`; `scope: 'agent'` by the agent id and shared
across that agent's users. Put nothing user-specific in an `agent`-scoped block.

## What the agent sees

Preloaded values arrive in the system prompt:

```
## Context from Past Conversations

[2026-03-10] memory: the user is allergic to peanuts.
```

Working-memory blocks arrive as their own section, with a directive telling the model to
keep them current via the tool.

## Backends

| store | extracted values | working-memory blocks |
| --- | --- | --- |
| in-process | `InMemoryExtractedValueStore` | `InMemoryPersistentMemoryStore` |
| filesystem | `FileExtractedValueStore` | `FilePersistentMemoryStore` |
| Postgres | `PostgresExtractedValueStore` | `PostgresPersistentMemoryStore` |
| Redis | `RedisExtractedValueStore` | `RedisPersistentMemoryStore` |
| Durable Object SQLite | `SqlExtractedValueStore` | `SqlPersistentMemoryStore` |

Wire them with `extractedValueStore` on `createRuntime` and `workingMemory.store` on the
agent (or `defaultWorkingMemoryStore` on the runtime).

The in-memory stores lose everything on restart. That is fine for a test and wrong for a
deployment — a memory feature that works in one process and forgets across a restart
fails exactly where it was supposed to help.
