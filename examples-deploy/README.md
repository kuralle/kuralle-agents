# Deploy smokes (Cloudflare Workers)

Minimal **deployable** cf-agent Workers that prove a primitive works end-to-end on a
real Cloudflare Durable Object — not just in the offline `workerd` test harness. Each is a
standalone package (its own `package.json` + `wrangler.jsonc`), so it is **not** part of the
monorepo build/typecheck; run it manually against your own Cloudflare account.

| Dir | Proves | Endpoint |
|-----|--------|----------|
| `kuralle-memory-smoke` | Working memory persists in the DO's SQLite (`SqlPersistentMemoryStore`) and recalls across requests | `GET /agents/memory-agent/<id>/chat?userId=U&q=...` |
| `kuralle-skill-smoke` | Skills progressive disclosure — the agent calls `load_skill` on a deployed DO and grounds its answer in the SKILL.md | `GET /agents/skill-agent/<id>/chat?q=...` |

## Run one

```bash
cd kuralle-skill-smoke
bun install
echo "$OPENAI_API_KEY" | npx wrangler secret put OPENAI_API_KEY
npx wrangler deploy
# hit it:
curl -s "https://kuralle-skill-smoke.<your-subdomain>.workers.dev/agents/skill-agent/s1/chat"
# tear down:
npx wrangler delete
```

Both were verified live (memory: store → recall across two requests; skills:
`toolCalls: ["load_skill","lookup_order"]` with a policy-grounded answer) and the
Workers were deleted after. Redeploy from here to reproduce.
