# marketing-team

A Kuralle port of [`vercel-labs/marketing-team-eve-template`](https://github.com/vercel-labs/marketing-team-eve-template):
a lead agent that grounds itself in a shared brand-context document, then routes to one of five
specialists (product marketer, content marketer, social media coordinator, SEO, email) to plan and
produce marketing content. Unlike the original, this version is self-contained — every external
SaaS dependency (Vercel Blob, Notion, Typefully, Resend) is replaced by local Postgres, so it runs
with no third-party accounts.

**This is the shell only.** There is no agent, no tool, and no database schema yet — just the app
skeleton (package, server, database client, Docker Compose for Postgres) that later tasks build on.
Do not expect marketing functionality from this state of the app.

## Setup

```bash
docker compose up -d          # starts Postgres on localhost:5433
cp .env.example .env
bun install
bun run dev:server             # starts the Hono server
```

## Scripts

| Script | Purpose |
| --- | --- |
| `db:generate` | Generate a Drizzle migration from `db/schema.ts` |
| `db:migrate` | Apply pending migrations |
| `db:studio` | Open Drizzle Studio against the local database |
| `dev:server` | Run the Hono server |
| `typecheck` | `tsc --noEmit` |
| `test` | Run the test suite |
