# Handoff — Sprint 3 → Sprint 4 (final sprint + REAL publish)

> **One page. Read first.** Depth in [`WARMDOWN.md`](./WARMDOWN.md).

## State of the world (one paragraph)
Sprint 3 (Cascaded TTFT) is complete: the LiveKit cascaded adapter records `aria_runtime_ttft` at the first `text-delta` (proven deterministically — the §11 gate, which does NOT fire), and the live e2e has a turn-correlated first-chunk-before-turn-end assertion (skip-guarded). All streaming behavior is now in place across text, native-realtime voice, and cascaded. Full `test` green; `typecheck:all` no new failures over the 4 frozen baseline configs (B-06). **Sprint 4 is the release:** live smoke example + docs/ADR-0004 + unified `0.4.0` bump + **real `pnpm publish -r` to npm** (the user explicitly authorized a real incremental 0.4.0 minor publish, overriding the kickoff's dry-run ceiling).

## Sprint 4 goal (verbatim from WBS)
**Land the live streaming smoke example, the docs + ADR-0004 amendments (with the native-realtime caveat), and the unified `0.4.0` version bump with a clean publish-together dry run** — then, per user directive, the **real** publish.

## Read these first
1. `sprints/STATE.md` — active sprint = 4 + load-bearing reading.
2. `sprints/WBS.md` § Sprint 4 (S4-01 smoke, S4-02 docs/ADR, S4-03 0.4.0 bump).
3. `sprints/sprint-3/WARMDOWN.md` §10 (the release pointers + the user directive).
4. `docs/rfc-streaming-by-default.md` §8 (C10/C11), REQ-9/11, §12 Q4.
5. `CLAUDE.md` "Gotchas & disciplines" — **version+publish together; pnpm rewrites `workspace:*` to exact versions (piecemeal = two copies of core); no `.env`/`.map` in tarballs; run `npm`/`wrangler` from a neutral cwd; publish with `pnpm publish -r`.**

## Traps to know about
- **Version the WHOLE graph together** (all 28 packages 0.3.20 → 0.4.0, manual-version per the 0.x + `workspace:*` gotcha). Never publish `core` alone.
- **Real publish is permanent/public.** Do `pnpm publish -r --dry-run` first, eyeball the pack contents (no `.env*` except `.env.example`, no `.map`), then the real `pnpm publish -r`. Run from a neutral cwd (repo root or /tmp).
- **B-06 (4 pre-existing test/example typecheck configs):** they do NOT ship (tarballs build from `src`, which is green), but the WBS flagged them as a release-quality gate. **Decide:** fix them, or document as non-shipping. (User wants the publish to proceed; the shipped code is clean.)
- **Breaking-change CHANGELOG note** required: `part.text` → `part.delta` + the lifecycle; downstream consumers (external Studio) migrate.
- Examples must be RUN, not just typechecked ("untested example = broken example").

## Open issues that block sprint 4
None hard. B-06 is a release-quality decision (shipped src is clean). npm auth must be present for the real publish (`npm whoami` / `pnpm` login).

## Start by running
```bash
cd /Users/mithushancj/Documents/asyncdot/openscoped/aria-flow && git checkout plan/streaming-by-default && cat sprints/STATE.md && bun run build && bun run test
```

## When you're done
Program complete after Sprint 4 + the real 0.4.0 publish. Tag `v0.4.0`. Note: the user authorized the publish; merging `plan/streaming-by-default` → `main` is a separate step — confirm/raise the PR after publish (or fast-forward main to the released commit).
