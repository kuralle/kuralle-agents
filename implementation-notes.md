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

### D2 — knip config + completing the dead-files pass (Task 21)
- Authored `knip.json` with accurate per-workspace entries (examples, test/tests, scripts, bench,
  client, servers, harness, sandbox-poc, `*.smoke.ts`, `*.test.mjs`, root-level `*.mjs` benches).
  Result: example/test/bench false-positive **file** flags went 60→0, and the **framework
  (packages/\*) + root dependency report is now completely clean**. Configured docs says
  configured `entry` *overrides* defaults (not merged), so src entries are listed explicitly;
  `includeEntryExports` left off so public-API exports in entry files aren't flagged.
- `ignoreDependencies` at root: `wrangler` (cf-agent example deploys), `@eslint/js` + `ws`
  (hoisted shared devtools used by workspaces/playground; root eslint.config uses only
  `typescript-eslint` and ignores `apps/**`, but the livekit-starter's own eslint config uses
  `@eslint/js`). `ignoreBinaries: ["napi"]` (wavekat-vad-node build).
- **Caught 2 dead barrels my first dead-files pass wrongly kept:** `kuralle-core/src/flow/index.ts`
  and `kuralle-livekit-plugin/src/metrics/index.ts`. The earlier "20/4 importers" was a **regex
  artifact** — that grep matched `src/types/flow.js` and `flow/classifyControl.js` (deep files),
  not the barrels. No file imports either barrel; their symbols are imported directly from the
  deep source files. Deleted both. **Lesson: trust a configured tool's module resolution over a
  hand-rolled import-regex for barrel reachability.**

### D3 — Redundant devDependency duplicates (Task 4 completion)
Removed 9 devDep entries that duplicated a `dependencies` entry in the same manifest (provably
safe — `dependencies` are installed in all contexts, so the devDep copy is pure redundancy):
`hono-server` (core, ai), `messaging` (core), `messaging-meta` (http-client, messaging),
`postgres-store` (core), `redis-store` (core), `tools` (core, rag), plus `widget`'s genuinely-dead
`convex` (only an unrelated `'convex-dev'` string in vite config). Section-aware removal kept the
`dependencies` copies intact. The peer-backing devDeps (in `peerDependencies`+`devDependencies`
but NOT `dependencies`, e.g. `rag` in the stores) were **left intact** — removing them would
unbind the peer for local builds. typecheck:all green.

### D4 — Dead exports: read-and-judge (Task 22)
knip flagged 127 unused export/type symbols. Verified each by actual usage. **No package uses
wildcard (`./*`) exports**, so internal-file exports are not consumer-reachable — and knip never
flags exports re-exported from entry files, so a flagged symbol is provably not public-API. Split:
- **68 used-elsewhere** (real import refs) — kept. These include the sub-module re-export barrels
  (`tools/effect/index.ts`, `runtime/channels/index.ts`, `runtime/grounding/index.ts`) whose
  symbols are imported via direct deep paths rather than through the barrel, and the
  **`openai-family` cloudflare-realtime subtree (29 symbols)** which is a *deliberate unwired
  capability* (it has its own `__tests__`) under the project's separate "wire-or-remove" review
  (`.handoff/recon/SYNTHESIS.md`) — NOT janitorial dead code. Left intact + flagged here.
- **20 truly-dead → deleted** (zero refs anywhere): `toNullableSchema`, `renderNodePrompt`,
  `sanitizeFlowControlSignal` (+ its orphan `FlowTransitionContinuation`), `mergeVoiceToolDefs`,
  the `buildVoiceNodePrompt` re-export alias, the 5-symbol unwired `pending-citations`-on-messages
  cluster, `ContextOverflowUnrecoverableError` + `isApiCallContextOverflow`, 4 unused policy
  builders, 2 dead cf-agent test stubs, and the `Tool.ts` runtime-context cluster (3). Orphaned
  imports cleaned (`FlowPromptContext`, `Session`, `APICallError`, `EnforcementRule`, `Runtime`, 4
  policy types). ~441 lines removed.
- **31 used-only-intra-file → demoted** (removed `export`, kept the symbol private).
- **Supporting-type trap:** my first intra-usage heuristic wrongly marked `BrandVoiceTemplate`,
  `ToolExecutionContextWithRuntime` for deletion — they're referenced by *other* exported
  declarations. Re-verified with a supporting-type-aware check; `BrandVoiceTemplate` is a knip
  false positive (kept exported); `ToolExecutionContextWithRuntime`'s only users were themselves
  deleted (so it went too). A full **declaration-emit build** (`build:packages`, not just
  `--noEmit`) was the arbiter for `TS4023` "using private name" — none surfaced. knip
  exports 80→45, types 47→31 (the remainder are the intentional barrels + the kept unwired subtree).

### D5 — Fixed pre-existing broken `bun run build` (encountered during verification)
`scripts/build-packages.sh` line 25 (`tier studio e2e-tests`) referenced `@kuralle-agents/studio`
(dropped in the rebrand — no such package) and `e2e-tests` (no build step), so `bun run build`
had failed with "No packages matched the filter" since commit `bc30551`. Removed the stale T6
tier. `bun run build:packages` now exits 0. Not one of the three assigned tasks, but a five-minute
tie-off of a broken build I hit while verifying the export work.

### D6 — Playground gate (Task 23) + apps/* dep decision
- Added `scripts/typecheck-playground.sh` (sweeps all 7 `apps/playground/*` tsconfigs) and wired it
  into `typecheck:all` (+ standalone `typecheck:playground`). All 7 were already green; proven to
  catch a planted type error. This closes the rot hole (the framework sweep only scans `packages/`).
- **apps/\* unused deps — deliberately NOT removed.** The improved knip config surfaced ~15 "unused"
  deps in the demo apps. I grep-verified every one: they are **dynamic-runtime deps static analysis
  can't see** — `@ai-sdk/*` providers are chosen at runtime by `resolveTemplateModel`'s
  xAI→Google→OpenAI key-presence logic (see CLAUDE.md gotcha), `@livekit/agents-plugin-*` are loaded
  by name, `@hono/node-*` run the demo servers — plus genuine config deps (typedoc plugins, tailwind,
  `@trivago/prettier-plugin`, opusscript). Removing them would break demos at *runtime* (uncaught by
  typecheck). Correct call: keep them, and teach knip via `ignoreDependencies` on the playground
  workspaces so the report stays signal. The **framework (`packages/*`) dep report is now 100% clean.**
- **Known-benign remainder** (documented, not fixed — `apps/docs` is a separate deployable, not the
  framework): 4 docs build-tool deps (typedoc/tailwind/starlight) that knip's plugin detection misses,
  and 4 "unlisted" imports in `apps/docs/src/examples/*` (hono/redis/@hono-node-*) — doc example code
  that demonstrates framework usage and resolves via workspace hoisting. Left for a docs-scoped pass.

## Final state
- `bun run typecheck:all` → green (57 framework configs + 7 playground configs + eslint).
- `bun run build:packages` → green (0 TS errors).
- knip framework report: 0 dep/devDep/unlisted flags. Remaining export/type flags (45/31) are
  documented-intentional (sub-module re-export barrels + the unwired `openai-family` subtree).
- Commits: deps prune, knip config + 2 barrels + redundant devDeps, dead-export pass + build fix,
  playground gate.
