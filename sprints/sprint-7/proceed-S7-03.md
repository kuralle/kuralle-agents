# Proceed Evidence — `S7-03` F3: README + docs + publish-together dry-run

> **Manager artifact — Phase A only.** Phase A complete after this — **and the entire WBS.**

## Story
- **Id:** `S7-03` · **Commit:** `7b97159` · **Slug:** `s7-03` · **Worker:** cursor.

## Proceed checklist (manager — read diff, did not trust IC chat)
- [x] **Diff read** — `engagement/README.md` (+113, real docs replacing the S0-01 stub), `apps/docs/src/content/docs/guides/engagement.mdx` (new guide) + `astro.config.mjs` (sidebar), `engagement/package.json` (0.0.0 → 0.2.0 release-prep), `artifacts/s7-03-release.txt`. Scope matches brief.
- [x] **Docs** — README documents the shipped API (engagement({policies}), pipeline/gates, 3 policies, withChoices, broadcasts); docs guide page builds (apps/docs).
- [x] **§9 matrix — IC was honest about a real gotcha** — a single `bun test` with 4 paths under-discovers; the IC ran the four suites **separately**. **Independently re-verified by manager:** core **374**, messaging **448**, messaging-meta **303**, engagement **85** = **1210 pass / 0 fail**. `typecheck:all` green.
- [x] **Publish-together dry-run — actually ran, honestly reported.** `pnpm publish -r --dry-run --no-git-checks` exit 0 (first attempt failed `ERR_PNPM_GIT_UNCLEAN` pre-commit — expected; retried with `--no-git-checks`, **dry-run only**). The `-r` dry-run shows only `@kuralle-agents/engagement@0.2.0` (the others are already at registry versions) — the IC flagged this nuance and used **`pnpm pack`** to verify the `workspace:*` rewrite: engagement pins **core@0.2.1, messaging@0.2.0, messaging-meta@0.2.0** (current graph) → **no split-graph pin**. No `.map` in any tarball (`check-no-source-maps.sh` green; `find … -name '*.map'` empty).
- [x] **No real publish** — proof contains only `--dry-run`/`pack` commands; manager confirmed no `npm/pnpm publish` without `--dry-run`. Per platform rules, never published.
- [x] **`verify-handoff-proof.sh s7-03` → `PROOF_OK`** (4 claims, 4 assertions) — first-try clean.
- [x] No `--no-verify`/suppression. Demo artifact committed. No stray notes.

**Verdict:** `PROCEED` — **Phase A complete; WBS exhausted.**

## One-line summary
`@kuralle-agents/engagement` README + docs guide; `typecheck:all` green; full §9 matrix **1210 pass / 0 fail** (verified sequentially); publish-together dry-run clean — engagement@0.2.0 rewrites to the current graph (no split-pin), no `.map`, no real publish · proof `s7-03` · commit `7b97159`.

## Notes
- **Honesty highlight:** the IC caught and disclosed the multi-path `bun test` under-discovery gotcha and the `-r`-dry-run-shows-only-new-package nuance, and used `pnpm pack` to do the real split-pin verification. No fabricated clean run. This is exactly the §12 standard.
- **Version:** engagement 0.0.0 → 0.2.0 (release-prep) — aligns with the messaging graph. A real release would version+publish the whole changed graph together (`pnpm release`), per CLAUDE.md.
