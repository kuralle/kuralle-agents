# Implementation Notes — Dead-code & dep cleanup + playground gate

Running log of decisions, deviations, and tradeoffs for the cleanup sprint
(knip-flagged unused deps, unused exports, and the un-gated playground apps).
Date: 2026-05-31. Branch: `main`.

## Scope (from the backlog)
1. **Prune unused deps** — knip baseline: 15 unused deps, 31 devDeps, 1 unlisted (`dotenv`).
2. **Author an accurate knip config** — the repo had *none*, so knip guessed entry points
   and flagged the entire example/test/bench suite as "unused files." A correct config is
   the prerequisite that makes both the dep and export reports trustworthy, and leaves the
   repo with a durable dead-code gate.
3. **Review unused exports** — knip baseline: 104 unused exports + 51 unused types.
   Read-and-judge, not bulk delete: keep public API, remove genuinely-dead.
4. **Gate playground apps** — `apps/playground/*` are excluded from `typecheck:all`
   (the sweep only scans `packages/`), so they rot silently. Add a gate.

## Decision log

### D0 — Methodology
- **Deps are verified by direct grep, not by trusting knip.** knip misses usage in
  `.mjs`, config files, and `package.json` scripts — exactly the false-positive classes
  here. grep across the whole package tree (all extensions + manifest scripts) is ground
  truth. knip is used to *generate the candidate list*, grep to *adjudicate*.
- **Breaking changes are allowed** per the explicit instruction. Removing a genuinely-dead
  public export is a breaking change we accept when the symbol is provably unused.

### D1 — Dependency verdicts (Task 4)
Of 46 knip-flagged deps, **29 were false positives** (used in examples/tests/`.mjs`/configs
knip didn't scan) and **17 candidate-dead**. After a second grep pass (tsconfig `types`,
`.changeset/config.json`, repo-wide CLI usage, comment-vs-import):

**KEPT (false positives) — notable reasons:**
- `wrangler` (root) — used by the 4 `cf-agent/examples/cf-voice-realtime-*` deploys (`wrangler.jsonc`).
- `@eslint/js`, `@livekit/agents`, `@livekit/rtc-node`, `ws` (root) — used in eslint config / tests.
- `@cloudflare/workers-types` was a *contested* case (see below).
- All the `@kuralle-agents/*` devDep flags on stores/messaging/tools/hono-server — used in src/tests/examples.

**REMOVED (16 confirmed dead):**
- `kuralle-e2e-tests` deps: `@kuralle-agents/realtime-audio`, `@kuralle-agents/livekit-plugin-transport-sip`, `@livekit/agents-plugin-openai`, `@livekit/agents-plugin-xai` (zero refs).
- `kuralle-livekit-plugin` deps: `@kuralle-agents/realtime-audio` (only JSDoc mentions), `@kuralle-agents/voice-protocol`.
- root devDeps: `@changesets/changelog-github` (`.changeset/config.json` has `changelog:false`), `@napi-rs/cli` (redundant — `kuralle-wavekat-vad-node` declares its own).
- `create-kuralle-agents` devDep `tsx`; `kuralle-core` devDep `tsx` (no script/doc invokes it; Bun runs `.ts` natively).
- `kuralle-cf-agent` devDeps `@cloudflare/vitest-pool-workers`, `vitest` (package has no `test/` dir).
- `kuralle-hono-server` devDep `@ai-sdk/google`; `kuralle-tools` devDep `@ai-sdk/openai` (zero refs).

**EMPIRICAL (verified via the typecheck gate):**
- `@cloudflare/workers-types` in `kuralle-cf-agent` and `-transport-twilio`. cf-agent uses its *own*
  `DurableObjectAgentSurface` (not the Cloudflare `DurableObject` global); twilio references no Workers
  types. Removed both; gate stayed green → confirmed dead. (If the gate had broken, they'd be restored.)

**ADDED:** `dotenv` as a **devDependency** of `kuralle-realtime-audio` (knip "unlisted" — imported in `test/gemini-live-e2e.ts` but undeclared).
