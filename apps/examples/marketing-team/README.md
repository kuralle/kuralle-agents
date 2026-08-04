# marketing-team

A Kuralle port of [`vercel-labs/marketing-team-eve-template`](https://github.com/vercel-labs/marketing-team-eve-template):
a lead agent that grounds itself in a shared brand-context document, then routes to one of five
specialists (product marketer, content marketer, social media coordinator, SEO, email) to plan and
produce marketing content. Unlike the original, this version is self-contained — every external
SaaS dependency (Vercel Blob, Notion, Typefully, Resend) is replaced by local Postgres, so it runs
with no third-party accounts.

The lead and five specialists (`agent/`) run behind a Hono server (`server/`) exposing chat and
a REST surface over the same tools the agents use. A Next.js App Router frontend (`web/`) is the
place a human works: chat with the team at `/`, browse and edit content at `/content`, edit the
shared brand context at `/brand`, and manage uploaded assets at `/assets`.

The web app never talks to Postgres directly and never sees `DATABASE_URL` — it proxies every
`/api/*` call to the standalone Hono server (`web/next.config.ts`), because the agent runtime
reads its instructions/skills off disk with a Bun-only API a bundler can't resolve. Run the two
processes side by side:

```bash
docker compose up -d          # starts Postgres on localhost:5433
cp .env.example .env
bun install
bun run dev:server             # starts the Hono server on :4001
bun run dev                    # starts the Next.js app on :3000, proxying to it
```

## Scripts

| Script | Purpose |
| --- | --- |
| `db:generate` | Generate a Drizzle migration from `db/schema.ts` |
| `db:migrate` | Apply pending migrations |
| `db:studio` | Open Drizzle Studio against the local database |
| `db:seed` | Seed a demo workspace, brand context, and content pieces |
| `dev:server` | Run the Hono server (agents, tools, REST API) on `:4001` |
| `dev` | Run the Next.js frontend on `:3000` |
| `build` / `start` | Production build / serve of the Next.js frontend |
| `typecheck` | `tsc --noEmit` over `db/`, `server/`, `agent/`, `test/` |
| `test` | Run the test suite |
