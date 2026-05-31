# @kuralle-templates/nextjs-chatbot

A lean Next.js chat UI wired to an in-process **Kuralle** agent. Clone, set one API key, run, chat.

Built from the [Vercel AI Chatbot](https://github.com/vercel/ai-chatbot) UI — stripped of auth, Drizzle ORM, Redis, Blob storage, artifacts, and resumable streams. Kuralle is the brain; the polished chat UI is the star.

## Quick start

```bash
cd apps/templates/nextjs-chatbot
pnpm install
cp .env.example .env.local
# Add OPENAI_API_KEY to .env.local
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## How it works

| Layer | Location |
|-------|----------|
| Chat UI | `components/chat/` — messages, input, sidebar history |
| API routes | `app/(chat)/api/` — chat, history, thread load/delete |
| Kuralle agent | `lib/kuralle/agent.ts` — `defineAgent` + `createRuntime` |
| Stream bridge | `lib/kuralle/stream-bridge.ts` — `HarnessStreamPart` → AI SDK UI stream |

On each message, the route calls `runtime.run({ sessionId, input, userId })` where `sessionId` is the chat id from the UI. Threads are persisted in Kuralle `SessionStore` (in-memory by default, PostgreSQL when `POSTGRES_URL` is set).

The sidebar loads `GET /api/history` (scoped by an anonymous cookie user id). Reopening a thread loads `GET /api/chat/[id]` and hydrates the chat UI.

## Customize the agent

Edit `lib/kuralle/agent.ts`:

```typescript
import { defineAgent, createRuntime, MemoryStore } from "@kuralle-agents/core";
import { openai } from "@ai-sdk/openai";

export const chatAgent = defineAgent({
  id: "chat-assistant",
  instructions: "Your system prompt here",
  model: openai("gpt-4o-mini"),
});

export const runtime = createRuntime({
  agents: [chatAgent],
  defaultAgentId: chatAgent.id,
  sessionStore: new MemoryStore(),
});
```

See `@kuralle-agents/core` examples under `packages/kuralle-core/examples/` for tools, flows, triage, and handoffs.

## Scripts

```bash
pnpm dev        # development server
pnpm build      # production build
pnpm start      # start production server
pnpm typecheck  # tsc --noEmit
```

## What was removed

- NextAuth / guest login
- Drizzle + custom Postgres schema (messages, votes, documents)
- Vercel Blob file uploads
- Artifacts / canvas panel
- Redis resumable streams
- BotID, geo/IP rate limiting, AI Gateway entitlements
- Telemetry / OpenTelemetry instrumentation

Thread history uses **Kuralle `SessionStore` only** — no separate ORM or chat tables.

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI API key for the agent model |
| `OPENAI_MODEL` | No | Model id (default: `gpt-4o-mini`) |
| `POSTGRES_URL` | No | PostgreSQL connection string. When set, uses `@kuralle-agents/postgres-store` for durable threads across server restarts. When unset, uses in-memory `MemoryStore` (per process). |

### Anonymous user scoping

There is no auth. A stable `kuralle-user-id` HTTP-only cookie scopes `SessionStore.list(userId)` so the sidebar only shows threads for this browser.

## Monorepo note

This template lives in the Kuralle monorepo and depends on `@kuralle-agents/core` and `@kuralle-agents/postgres-store` via `workspace:*`. When copied outside the monorepo, replace those dependencies with published npm versions:

```json
"@kuralle-agents/core": "^2.0.0",
"@kuralle-agents/postgres-store": "^2.0.0"
```
