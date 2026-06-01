# Story Brief — `S7-03` F3: README + docs + publish-together dry-run

> **IC engineer (`cursor`, fresh process).** Self-contained. Ambiguity → **stop and ask**.
> **Atomic-commit:** `[S7-03] F3 README + docs + publish-together dry-run` on **`plan/whatsapp-engagement`**. No push/`main`, one commit. **Bun for tests; pnpm for the publish dry-run.**

## 1. Goal
Package README (`@kuralle-agents/engagement`) + a docs guide page; full `bun run typecheck:all` + the §9 test matrix green; a **publish-together dry-run** (`pnpm publish -r --dry-run`) clean across the changed `@kuralle-agents/*` graph (no split-graph pin, no `.map` in tarballs). This is the program's release-readiness gate.

## 2. Required reading
1. `sprints/STATE.md`; `sprints/sprint-7/PLAN.md` § Story `S7-03` + § 0 (esp. the publish-together + neutral-cwd + fallback rules).
2. RFC `04-...` §9 (the full validation matrix); `02-...` §4.5.
3. **`CLAUDE.md` (repo root)** — "Publish with `pnpm publish -r`"; "No source maps (`.map`) in published tarballs"; **version + publish the whole `@kuralle-agents/*` graph together** (publishing `core` alone leaves dependents pinning the old exact `core` → two copies → tsc errors). Also the gotcha: `npm`/`wrangler` `config.load()` fails when run from inside a monorepo package dir → run from a neutral cwd (repo root or /tmp).
4. Source: `packages/kuralle-engagement/{README.md (S0-01 stub), package.json (version 0.0.0)}`, root `package.json` (scripts `release`/`changeset:publish`/`check:no-source-maps`), `scripts/check-no-source-maps.sh`, `apps/docs/` (docs site — find where a guide page goes).

> `bun run build` first.

## 3. Specs
**README (`packages/kuralle-engagement/README.md`):** replace the S0-01 stub with real docs — what `@kuralle-agents/engagement` is (channel-agnostic engagement layer), the `engagement({policies})` wiring (`.bridge` → `createMessagingRouter`, `.broadcasts`), the window-safe pipeline + gates (consent/ownership/closed-window-recovery/interactive-renderer/windowGuard), the three `ChannelPolicy` adapters (WhatsApp/web/Instagram), interactive `withChoices`/stable-id routing, broadcasts/drips. A short usage snippet. Keep it accurate to the shipped API.
**Docs guide page:** add a guide under `apps/docs/` per the site's convention (find an existing guide for the structure — frontmatter, sidebar). If `apps/docs/` structure is unclear or it's excluded from CI, add at least a package-level `docs/` guide and note it. Don't break the docs build.
**Gate runs (capture all in the demo artifact `sprints/sprint-7/artifacts/s7-03-release.txt`):**
1. `bun run typecheck:all` → green.
2. `bun test packages/kuralle-core packages/kuralle-messaging packages/kuralle-messaging-meta packages/kuralle-engagement` → all green (the §9 matrix).
3. **Publish-together dry-run** — from a **neutral cwd** (repo root): `pnpm publish -r --dry-run` (this rewrites `workspace:*` to real versions and reports what would publish). Capture the output. Verify: (a) the changed `@kuralle-agents/*` packages (core, messaging, messaging-meta, engagement) would publish **together** with consistent versions — **no split-graph pin** (no dependent pinning an old exact `core`); (b) no `.map` files in the would-be tarballs — run `bash scripts/check-no-source-maps.sh` (or `find packages/*/dist -name '*.map'` → empty after a clean build).
   - **If `engagement` is `0.0.0`** and the dry-run requires a real version, bump the changed packages to a consistent version (release-prep) and note it. Use `workspace:*` deps internally (pnpm rewrites them).
   - **If `pnpm publish -r --dry-run` cannot run** in this environment (pnpm missing / registry / auth — dry-run shouldn't need auth but may): fall back to `npm pack --dry-run` per changed package from a neutral cwd + a manual check that internal deps are `workspace:*` (so they rewrite correctly) and no `.map` in dist. **Capture the exact failure and FLAG it** in your report — do NOT fake a clean dry-run.
   - **NEVER run a real publish** — `--dry-run` only.

**Files:** `packages/kuralle-engagement/README.md`, a docs guide page, possibly `package.json` version bumps (release-prep), `sprints/sprint-7/artifacts/s7-03-release.txt`.

## 4. Acceptance criteria
1. `engagement` README documents the shipped API accurately (no stale/aspirational claims).
2. A docs guide page added (or a noted package-level fallback) without breaking the docs build.
3. `bun run typecheck:all` green; full §9 suite green.
4. **Publish-together dry-run** clean (no split-graph pin, no `.map`) — OR an honest, captured fallback (`npm pack --dry-run` + manual checks) with the limitation flagged. Output in `s7-03-release.txt`.
5. No real publish performed (`--dry-run` only).

## 5. What NOT to do
- **Never run a real `pnpm publish` / `npm publish`** — dry-run only.
- Don't claim a clean dry-run you didn't actually get — flag environmental blockers honestly.
- Don't publish `core` (or any package) alone — the graph publishes together.
- No `any`/`@ts-ignore`/`--no-verify`/silent catch; no source maps.

## 6. Validation contract (`.handoff/proof-s7-03.json`)
`assertions_required`: `cmd:typecheck_all`, `cmd:full_suite`, `cmd:publish_dry_run`, `cmd:no_source_maps`.

| claim_id | command | satisfies_assertions |
|----------|---------|----------------------|
| typecheck | `bun run typecheck:all` | cmd:typecheck_all |
| suite | `bun test packages/kuralle-core packages/kuralle-messaging packages/kuralle-messaging-meta packages/kuralle-engagement` | cmd:full_suite |
| dry-run | `sh -c 'cd "$(git rev-parse --show-toplevel)" && pnpm publish -r --dry-run'` (or the documented fallback) | cmd:publish_dry_run |
| no-maps | `sh -c '[ -z "$(find packages/kuralle-engagement/dist packages/kuralle-messaging/dist -name "*.map")" ]'` | cmd:no_source_maps |

(If the dry-run uses the fallback, set `cmd:publish_dry_run`'s command to the fallback you ran and explain in the report. Keep `exit_code` honest.)

### PROOF SCHEMA CHEAT-SHEET (follow exactly)
- `claims[].type` ∈ **`test_suite`|`typecheck`|`lint`|`http`|`custom_command`|`ui_recording`|`file_exists`** only (`bun test`→`test_suite`, `typecheck:all`→`typecheck`, the dry-run / find → `custom_command`).
- Each claim: **`id`** (NOT `claim_id`) = sidecar basename (`.handoff/proof-s7-03-<id>.stdout`) + `stdout_sidecar`, `command`, `cwd`, `exit_code`, `stdout_sha256`, `satisfies_assertions`.
- `commands_run[]` `purpose`=`"verification"`; `claim_id` matches a `claims[].id`. `assertions_satisfied`==`assertions_required`. Sentinel `echo "DONE $(git rev-parse HEAD) proof=.handoff/proof-s7-03.json" > .handoff/result-s7-03.done`.

## 7. Demo artifact
`sprints/sprint-7/artifacts/s7-03-release.txt` — typecheck + suite + dry-run output (+ no-maps). **`git add` it.**

## 8. Report back
Files, commit sha, proof slug `s7-03`, DoD, demo, trade-offs — **especially the publish dry-run: did `pnpm publish -r --dry-run` run cleanly, or did you use the fallback? Any split-graph-pin or version issue? Any version bumps you made.** Be honest about what you could and couldn't verify. **No `*-implementation-notes.md`.** No PR.

## 9. If stuck
- The publish dry-run is the most environment-dependent step — if it can't run, the fallback + an honest flag is the correct outcome (NOT a fabricated pass). Capture the real error.
- Baseline green pre-story (896 tests). No shortcuts; never a real publish.
