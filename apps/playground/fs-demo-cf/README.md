# fs-demo-cf — kuralle-fs on Cloudflare (via @kuralle-agents/cf-agent)

A persistent workspace hosted by a **cf-agent** (`KuralleAgent`) Durable Object.
`KuralleAgent` extends Cloudflare's `AIChatAgent` — it *is* a CF Agents DO, not a
custom one — and its `workspace` is a `SqlFileSystem` over the DO's own
`ctx.storage.sql`. So the agent's files (and anything the workspace tool writes)
persist across turns and restarts — the ghost-writes fix, on real Cloudflare infra,
through the cf-agent runtime.

**Live:** https://kuralle-fs-demo.mithushancj.workers.dev

```bash
curl -X POST "$URL/fs/write" -H 'content-type: application/json' -d '{"path":"/kb/hours.md","content":"Open 9-5"}'
curl "$URL/fs/read?path=/kb/hours.md"   # persisted in the agent's DO SQLite
curl "$URL/fs/ls?path=/kb"
```

`src/index.ts` extends `KuralleAgent`, sets `workspace: { fs: sqlFileSystem(this.ctx.storage.sql) }`
in `getAgents()`, and exposes the `workspace` fs tool to the model. The `/fs/*` HTTP routes are a
thin verification surface; the agent's chat endpoint is served by `routeAgentRequest`.

Deploy: `bun install` (repo root), set `wrangler secret put OPENAI_API_KEY`, then `wrangler deploy`.
