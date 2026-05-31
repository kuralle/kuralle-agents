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
1. ✅ **DONE — Remove dead files** (`8622fa0`). 9 verified-dead files deleted from `packages/*/src` (5 orphaned impl files + 4 unimported re-export barrels); `flow/index.ts`/`metrics/index.ts` were knip false-positives and kept. `typecheck:all` green. knip's raw list also flags every example/test/bench as "unused" — those are runnable entry points, not dead code.
2. ✅ **DONE — Source-map leak fixed** (`1dc7a6a`). The leak was `@kuralle-agents/analytics-sdk@0.2.0`: built with `bun build --sourcemap` + `files:['src','dist']`, so it shipped both `dist/*.map` **and** raw TS source. Switched it to the standard tsc/dist model (compiled `.js`+`.d.ts`, `files:['dist']`, no maps), republished clean as `0.2.1`, **unpublished the leaked `0.2.0`** (tarball confirmed gone from registry). Added `scripts/check-no-source-maps.sh` (fails release on any `.map`/raw-`src` in a tarball), wired into `changeset:publish`. The other 0.2.1 packages (core/hono-server/postgres-store) were already clean.
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
