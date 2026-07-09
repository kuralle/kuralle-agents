# fs-demo-cf — kuralle-fs on Cloudflare

A Worker + Durable Object showing a **persistent** `SqlFileSystem` over the DO's
`ctx.storage.sql`. Files written in one request survive for the next — the
ghost-writes fix on real Cloudflare infra. No external DB, no LLM.

**Live:** https://kuralle-fs-demo.mithushancj.workers.dev

```bash
curl -X POST "$URL/fs/write" -H 'content-type: application/json' -d '{"path":"/kb/hours.md","content":"Open 9-5"}'
curl "$URL/fs/read?path=/kb/hours.md"   # persisted across requests
curl "$URL/fs/ls?path=/kb"
```

Deploy: `bun install` (repo root) then `wrangler deploy` here. wrangler bundles the
workspace packages from source — only the root `@kuralle-agents/fs` export is pulled
(no just-bash, no node:sqlite), so the Worker bundle stays clean.
