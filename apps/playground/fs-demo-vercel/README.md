# fs-demo-vercel — kuralle-fs on Vercel

A Node serverless function showing the portable workspace filesystem consuming an
Open Knowledge Format (OKF) bundle over `InMemoryFs` — `ls`/`read`/`grep` and
concept navigation.

**Live:** https://fs-demo-vercel.vercel.app

```bash
curl "$URL/api/concepts"                                  # OKF concept graph
curl "$URL/api/read?path=/metrics/weekly_active_users.md"
curl "$URL/api/grep?q=user_id"
```

Vercel functions are stateless (no persistent disk); for persistence point
`sqlFileSystem` at a hosted SQLite (Turso libSQL) — the same platform-chosen backend
as Cloudflare's DO SQLite.

## Build & deploy
The unpublished workspace packages are **pre-bundled** with esbuild into
`api/index.js` (self-contained, ~26KB), so Vercel deploys with no install:

```bash
# rebuild the bundle (needs the workspace deps linked; run from repo with the
# two @kuralle-agents/* deps temporarily added to package.json, or from the monorepo):
bunx esbuild src/handler.ts --bundle --platform=node --format=esm --target=node20 --outfile=api/index.js
vercel deploy --prod --yes --scope <your-team>
```
