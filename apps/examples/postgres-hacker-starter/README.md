# Postgres hacker starter

A production-runnable, text-first Kuralle web application. It combines a Next.js App Router interface, an in-process Hono API, official AI SDK Elements, local Postgres with pgvector, durable Kuralle sessions and traces, retrieval-led answering, explicit memory tools, and human approval for persistent writes.

## Start locally

Copy `.env.example` to `.env.local`, fill in `OPENAI_API_KEY` and a random cookie secret of at least 32 characters, then run:

```bash
bun install
bun run db:up
bun run db:migrate
bun run db:seed
bun run dev
```

Open `http://localhost:3000`. The included database container listens on port `55432` so it does not collide with a conventional host Postgres installation.

Pi is the default Kuralle channel driver. To exercise the same agent with Core's built-in AI SDK driver, set:

```bash
KURALLE_DRIVER=ai-sdk bun run dev
```

For an optimized process:

```bash
bun run build
bun run start
```

## What was preserved

The application keeps five useful agent/database patterns:

1. Every domain answer is preceded by automatic retrieval from a shared pgvector corpus, with full-text fallback if embedding fails.
2. User memories are explicit slots with remember, exact recall, semantic/text search, list, and forget operations.
3. The runtime preloads the server-authenticated profile and relevant memory before each answer.
4. Order lookup demonstrates ordinary function-tool CRUD against shared data (`order_1001` and `order_1002`).
5. Kuralle persists complete sessions and traces, while a compact user-scoped report is upserted after each completed turn.

## Security model

- The Hono API creates a UUID identity and stores it only in a signed, HTTP-only, same-site cookie. Production cookies use the `__Host-` prefix and `Secure` attribute.
- The browser never supplies a trusted user id. Every durable session id is namespaced server-side by the cookie identity.
- All profile and memory queries include that identity. The database is not directly reachable from browser code.
- Profile updates, memory writes, and memory deletion pause as request-bound Kuralle approvals. The UI shows the frozen tool and exact arguments before accepting a decision.
- Inputs are schema-validated and SQL is parameterized. Memory labels are normalized into a constrained slot key.
- Embedding outages degrade to Postgres full-text search; they do not silently discard a requested memory write.

## Hono API

The optional catch-all Next.js route mounts one Hono application under `/api`:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/health` | database/runtime readiness and active driver |
| `GET` | `/api/bootstrap` | issue/verify identity and load public profile state |
| `POST` | `/api/chat` | AI SDK `UIMessageStream` backed by a Kuralle turn |
| `POST` | `/api/chat/approval` | authenticated approve/deny delivery to a paused run |
| `GET` | `/api/profile` | current public profile fields |
| `GET` | `/api/memories` | current user’s memory slots |
| `GET` | `/api/sessions` | current user’s compact session reports |
| `GET` | `/api/orders/:orderId` | shared demo-order lookup |
| `GET` | `/api/knowledge/search?q=…` | authenticated retrieval inspection |

## Operations

```bash
bun run test
bun run typecheck
bun run build
RUN_PG_INTEGRATION=1 bun run test:integration
```

`test:integration` expects `DATABASE_URL` to point at an expendable migrated database. It creates one temporary user row and removes it afterward. The migration itself is additive and the seed uses idempotent upserts; neither clears existing data.

For production, replace the sample credentials, terminate TLS before the application, restrict database network access to the app, run migrations as a release step, back up both Kuralle and domain tables, and rotate the cookie secret through a planned sign-out window.
