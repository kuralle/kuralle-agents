# fs-demo-vercel — kuralle-fs on Vercel (persistent via Turso)

A Node serverless function with a **persistent** `SqlFileSystem` workspace. Vercel
functions are stateless (no durable local disk), so persistence lives in **Turso**
(libSQL — SQLite-compatible, so the SqlFileSystem SQL runs unchanged). Same
platform-chosen backend as Cloudflare, where the handle is a Durable Object's
`ctx.storage.sql` instead of a hosted libSQL client.

**Live:** https://fs-demo-vercel.vercel.app

```bash
curl -X POST "$URL/api/write" -H 'content-type: application/json' -d '{"path":"/kb/hours.md","content":"Open 9-5"}'
curl "$URL/api/read?path=/kb/hours.md"   # persisted in Turso across requests
curl "$URL/api/ls?path=/kb"
curl "$URL/api/concepts"                 # OKF concept graph
```

## Backend

`sqlFileSystem(libsqlBackend(url, token))` — the libSQL client wrapped as a two-method
`SqlBackend`. Reads `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` from the environment
(set as encrypted Vercel env vars). Falls back to `InMemoryFs` locally without creds.

## Build & deploy (two gotchas, both handled)

The unpublished workspace packages are **pre-bundled** with esbuild into a
self-contained `api/index.js`, so Vercel deploys with install skipped:

```bash
# 1. link build deps: package.json needs @kuralle-agents/core + @kuralle-agents/fs
#    (workspace:*) and @libsql/client, then `bun install` at the repo root.
# 2. bundle — MUST use the web libSQL client (no native binary) AND a createRequire
#    banner (its `ws` dep does a dynamic require that ESM otherwise can't resolve):
bunx esbuild src/handler.ts --bundle --platform=node --format=esm --target=node20 \
  --outfile=api/index.js \
  --banner:js="import{createRequire as __cr}from'module';const require=__cr(import.meta.url);"
# 3. reset package.json to deps-free (bundle is self-contained), then:
vercel env add TURSO_DATABASE_URL production --scope <team>   # libsql://... from `turso db show`
vercel env add TURSO_AUTH_TOKEN production --scope <team>     # from `turso db tokens create`
vercel deploy --prod --yes --scope <team>
```

Gotcha 1: the **node** `@libsql/client` needs a native binary (`@libsql/linux-x64-gnu`)
that can't be bundled — use `@libsql/client/web`. Gotcha 2: the web client pulls `ws`,
which does `require('events')` — the `createRequire` banner makes that work in the ESM bundle.
