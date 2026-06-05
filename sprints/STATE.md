# Project State

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down.

---

## Active sprint

**Sprint number:** `4`
**Sprint name:** Polish + 0.4.0 (final — REAL publish authorized)
**Status:** `not-started`
**Goal:** Land the live streaming smoke example, the docs + ADR-0004 amendments (native-realtime caveat), and the unified `0.4.0` version bump, then publish for real (`pnpm publish -r`) to npm. **User directive (this session): real incremental 0.4.0 minor publish — overrides the kickoff's dry-run ceiling.**
**WBS section:** [`sprints/WBS.md` § Sprint 4](./WBS.md)

## Build branch

**Active build branch:** `plan/streaming-by-default`

Every sprint session — manager and IC — works **on this branch only**. Before Step 1 of the kickoff, confirm `git branch --show-current` matches. All story commits (`[S{N}-{nn}]`), fix-pass (`[S{N}-fix]`), and closeout (`[S{N}-close]`) land here. Do **not** commit to `main` mid-sprint. Merge to `main` happens via a single PR after Sprint 4, paired with the real `pnpm release`.

At session start: `git checkout plan/streaming-by-default` (or, for the very first Sprint 0 session, cut it: `git checkout main && git pull && git checkout -b plan/streaming-by-default`).

## Load-bearing reading for sprint 4

The session running sprint 4 (final + REAL publish) must read these in this order:

1. `sprints/sprint-3/HANDOFF.md` — read-me-first; current state + the publish directive + traps.
2. `sprints/WBS.md` § Sprint 4 — S4-01 (live smoke), S4-02 (docs + ADR-0004), S4-03 (0.4.0 bump + publish).
3. `docs/rfc-streaming-by-default.md` §8 (C10/C11), REQ-9/11, §12 Q4.
4. `CLAUDE.md` "Gotchas & disciplines" — **version+publish together; pnpm rewrites `workspace:*`→exact (piecemeal = two copies of core); no `.env`/`.map` in tarballs; npm/wrangler from neutral cwd; `pnpm publish -r`.**
5. Current versions: all 28 publishable packages at `0.3.20` → bump to `0.4.0`. (2 internal pkgs at 0.0.x stay.)

**User directive (this session):** real incremental **0.4.0 minor** publish via `pnpm publish -r` to npm (current 0.3.20). Confirmed: 0.4.0 minor + real publish. **This overrides the kickoff's "dry-run ceiling / no autonomous publish."** Still: `pnpm publish -r --dry-run` + pack-content eyeball + private-leak scan BEFORE the real publish.

**Gate note:** `typecheck:all` RED baseline (4 frozen configs — B-06). Shipped src builds clean (`bun run build` green); the red is in unpublished test/example files. Decide B-06 (fix or document-as-non-shipping) as part of the release. Use the frozen-baseline guard. Tag `v0.4.0` after publish; main-merge is a separate step.

## Last completed sprint

`3` — Cascaded TTFT

## Last completed at

`2026-06-05`

## Sprint history

| Sprint | Status | Completed at | Warmdown |
|--------|--------|--------------|----------|
| 0 | done | 2026-06-05 | [sprint-0/WARMDOWN.md](./sprint-0/WARMDOWN.md) |
| 1 | done | 2026-06-05 | [sprint-1/WARMDOWN.md](./sprint-1/WARMDOWN.md) |
| 2 | done | 2026-06-05 | [sprint-2/WARMDOWN.md](./sprint-2/WARMDOWN.md) |
| 3 | done | 2026-06-05 | [sprint-3/WARMDOWN.md](./sprint-3/WARMDOWN.md) |
| 4 | not-started | — | — |

When a sprint completes, append a row here from `WARMDOWN.md`.

## Backlog deltas this project life

- **B-06** added (Sprint 0): fix pre-existing `typecheck:all` drift in test/example files (4 configs/14 errors); release blocker before Sprint 4's `0.4.0` gate. See WBS §4.
- **B-07** added (Sprint 1): investigate whether `Hook.onStreamPart`/`AgentStreamPart` is a dead public surface (no live `ctx.emit` feeds it); remove if confirmed dead. Post-0.4.0. See WBS §4.

## Open RFC amendments

- Sprint 1: `docs/rfc-streaming-by-default.md` REQ-6 + new §4.2.1 — `AgentStreamPart` (`types/processors.ts`) added as the third in-scope union (O1). Landed in commit `c1c41fe`.

## Open RFC amendments

`(none)`

---

## How to use this file

- A new session reads this file **first** to know which sprint is active and which sections of which docs are load-bearing right now.
- The session running a sprint **does not edit this file mid-sprint**. Updates land at warm-down.
- At warm-down, the session updates: active sprint pointer, **build branch** (only if it changed), load-bearing reading for the next sprint, last-completed fields, sprint history table, backlog deltas, and any open RFC amendments.
