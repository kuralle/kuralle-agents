# Session Handoff — Kuralle framework

Checkpoint for a fresh agent. References artifacts (commits/repos/packages) rather than re-narrating; see `git log` for detail.

## Where things live
- **Framework repo:** `github.com/kuralle/kuralle-agents` — **PRIVATE** (owner not ready to flip public).
- **Templates repo:** `github.com/kuralle/starter` — **PUBLIC**, tag `v0.2`. 8 templates; `create-kuralle-agents` fetches from it via giget.
- **Product repo (separate):** `github.com/octalpixel/kuralle` — the `@kuralle/*` SaaS (admin `apps/web`). Not this repo.
- **Published on npm:** `@kuralle-agents/core@0.2.1`, `hono-server@0.2.1`, `postgres-store@0.2.1`, `create-kuralle-agents@0.2.1`. **Every other package is still `0.2.0`.**
- **Live demo:** https://kuralle-chatbot.vercel.app (Vercel project `kuralle-chatbot` + Neon project `misty-morning-05448717`).
- **Docs:** Cloudflare Pages `kuralle-docs.pages.dev`; custom domain `docs.kuralle.com` pending a DNS CNAME the owner adds manually.

## What shipped this session
- AriaFlow → **Kuralle** rebrand; git history wiped + fresh.
- `create-kuralle-agents` rewritten to the **giget** model (Hono-style), publishing all 8 templates to `kuralle/starter`.
- New **`restaurant-order`** template — the first flow-based template (ported from Pipecat).
- **Core patch `0.2.1`** (commit `b0891b2`): flow-node `tools` now self-register their executors and receive run context — previously they silently needed redundant `agent.effectTools` (the footgun that broke both shipped flow examples).
- Monorepo cleanup: removed `apps/templates` (`581e4aa`) + dead `build-starter` pipeline.
- CLAUDE.md "Gotchas & disciplines" section (`68cf6b1`).

## Pending / next (in priority order)
1. **Remove dead files** — `knip` found ~11 high-confidence dead files under `packages/*/src` (e.g. `kuralle-core/src/runtime/SessionEventManager.ts`, `runtime/tokenSessionUtils.ts`, `tools/transferToTriage.ts`, `utils/aiStream.ts`, `utils/streamChunk.ts`). Verify each is unimported + absent from the package `exports` map, delete, confirm `bun run typecheck:all` stays green.
2. **Source maps in npm tarballs** — CLAUDE.md says "no `.map` in published tarballs"; owner explicitly wants to avoid a source-map leak. Verify `core/hono-server/postgres-store@0.2.1` tarballs contain no `.map`; if they do, fix the build/`files`/`.npmignore` and republish a patch.
3. **Prune unused deps** — `knip`: 15 unused deps + 31 devDeps.
4. **Review 78 unused exports + 49 unused exported types** (per-item; some are likely intended public API — do not bulk-delete).
5. **`apps/playground/*` rot** — excluded from `typecheck:all`, so they break silently (a trailing-comma `package.json` was just fixed). Either add to CI or fold into the relevant package's `examples/`. `transport-examples` is referenced by the livekit-plugin guides.
6. **Owner decisions:** flip `kuralle-agents` public; add the `docs.kuralle.com` CNAME; **rotate the OpenAI key** that was pasted in chat (only lives in gitignored `.env` files now).

## Run/verify notes (also in CLAUDE.md "Gotchas")
- **Publish whole graph together** — `pnpm` pins `workspace:*` to exact versions, so a lone `core` bump skews dependents → duplicate-install `tsc` errors.
- **Run examples live** — typecheck ≠ runtime.
- **Force OpenAI** in examples/templates by clearing `XAI_API_KEY` + Google keys (runner prefers xAI → Google → OpenAI).
- `npm`/`wrangler` `config.load()` errors inside package dirs — run from repo root or `/tmp`.

## Suggested skills for the next session
- `/diagnose` — for any runtime bug (built a clean repro loop is the win).
- `/code-review` — before any publish.
- `/improve-codebase-architecture` — for the broader flow-tools-vs-agent-tools ergonomics (the 0.2.1 fix closed the acute bug).

_No secrets in this document; the OpenAI key used for live tests exists only in gitignored `.env` files and must be rotated by the owner._
