# Production examples

These applications are complete, text-first Kuralle systems with durable side effects, explicit approval boundaries, tests, and operating notes.

| Example | Interface | Durable substrate | Core boundary |
| --- | --- | --- | --- |
| [Healthcare](healthcare/README.md) | terminal TUI | local SQLite | authenticated appointments and billing |
| [Hotel receptionist](hotel-receptionist/README.md) | terminal TUI | local SQLite + policy Markdown | verified bookings and hotel operations |
| [Postgres hacker starter](postgres-hacker-starter/README.md) | Next.js web app | local PostgreSQL + pgvector | signed identity, retrieval, memory, approvals |
| [Local Content Desk](content-agent/README.md) | terminal TUI | caller-owned local Markdown | skills, grounding, revisioned drafts and publication |
| [Pharmacy workspace agent](pharmacy-rx-agent/README.md) | Next.js web + hosted CLI | Cloudflare Durable Object SQLite | per-session mounted filesystems, progressive skills, native/HTTP transports |

Every example defaults to the Pi driver, including typed flow turns. Set
`KURALLE_DRIVER=ai-sdk` to run the same application on Core's built-in AI SDK driver.
