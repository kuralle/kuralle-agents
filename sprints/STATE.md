# Project State

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down.

---

## Active sprint

**Sprint number:** `—`
**Sprint name:** `(none — PROGRAM COMPLETE)`
**Status:** `program-complete`
**Goal:** `(WBS Sprints 0–7 all shipped — nothing active)`
**WBS section:** `(exhausted)`

> **PROGRAM COMPLETE.** All WBS sprints (0–7) are shipped on `plan/whatsapp-engagement`: `typecheck:all` green, §9 matrix 1210 pass / 0 fail, publish-together dry-run clean. The program stops here (driver § When to stop — "WBS complete"). Next: a human PR to `main` + a real `pnpm release` + live smoke (see `sprints/sprint-7/HANDOFF.md`). Pasting the kickoff prompt will find no Sprint 8 → report the program done.

## Build branch

**Active build branch:** `plan/whatsapp-engagement`

Every sprint session — manager and IC — works **on this branch only**. Before Step 1, confirm `git branch --show-current` matches. All story commits (`[S{N}-{nn}]`), fix-pass (`[S{N}-fix]`), and closeout (`[S{N}-close]`) land here. Do **not** commit to `main` mid-sprint unless this field is explicitly changed to `main`.

At session start: `git checkout plan/whatsapp-engagement` (or `git fetch && git checkout plan/whatsapp-engagement` if missing locally).

## Load-bearing reading for sprint 7 (final)

The session running sprint 7 must read these in this order before delegating any story:

1. `sprints/sprint-6/HANDOFF.md` — read-me-first; state of the world + Sprint 7 traps (esp. F1 chain composition + F3 publish-together).
2. `sprints/WBS.md` § Sprint 7 — the plan for this (final) sprint.
3. `sprints/SESSION_KICKOFF_PROMPT.md` — the loop you are running.
4. `rfcs/whatsapp-engagement/02-requirements-interfaces.md` — §4.5 (`engagement({policies})` → `{bridge, broadcasts}`); §9 validation matrix.
5. `rfcs/whatsapp-engagement/04-tasks-validation.md` — Phase F chunks (F1/F2/F3) + §9 full test matrix.
6. `CLAUDE.md` (repo root) — publish-together rule, no source maps, `pnpm publish -r`.
7. Source: `packages/kuralle-engagement/src/index.ts` (F1 `engagement()` wiring — composes `[consentGate, ownershipGate, closedWindowRecovery, interactiveRenderer, windowGuard]` from policies+stores), `packages/kuralle-messaging/src/adapter/createMessagingRouter.ts` (`.bridge` spreads `outbound`/`inputResolver`/`windowStore`/`ownership`/`consent`/`onStatus`), `packages/kuralle-messaging-meta/examples/multi-platform/` (F2), root `package.json` + `scripts/check-no-source-maps.sh` (F3).
8. `~/.claude/projects/-Users-mithushancj-Documents-asyncdot-openscoped-aria-flow/memory/MEMORY.md` — standing rules (Bun usage, no-shortcuts, **publish-together**).

### Sprint-0..6 seams Sprint 7 wires together
- All gates/middleware: `consentGate`/`ownershipGate` (S4), `closedWindowRecovery` (S6), `interactiveRenderer` (S3/S6), terminal `windowGuard` (S1) — F1 composes the default chain (windowGuard terminal) from the injected `policies[]` + stores.
- `whatsappPolicy`/`webPolicy`/`instagramPolicy` (S0-04/S6) — `engagement({policies:[...]})`.
- `broadcasts` (S5) — `engagement().broadcasts`.
- Inbound ownership gate + resolver chain (S3/S4) — wired via `.bridge` into `createMessagingRouter`.
- **Publish-together (CLAUDE.md):** version+publish the whole changed `@kuralle-agents/*` graph together (core/messaging/messaging-meta/engagement); dry-run from a neutral cwd; no split-graph pin; no `.map` in tarballs.

## Last completed sprint

`7` — Integration, proof & release **(FINAL — program complete)**

## Last completed at

`2026-06-01`

## Sprint history

| Sprint | Status | Completed at | Warmdown |
|--------|--------|--------------|----------|
| 0 | complete | 2026-06-01 | [sprint-0/WARMDOWN.md](./sprint-0/WARMDOWN.md) |
| 1 | complete | 2026-06-01 | [sprint-1/WARMDOWN.md](./sprint-1/WARMDOWN.md) |
| 2 | complete | 2026-06-01 | [sprint-2/WARMDOWN.md](./sprint-2/WARMDOWN.md) |
| 3 | complete | 2026-06-01 | [sprint-3/WARMDOWN.md](./sprint-3/WARMDOWN.md) |
| 4 | complete | 2026-06-01 | [sprint-4/WARMDOWN.md](./sprint-4/WARMDOWN.md) |
| 5 | complete | 2026-06-01 | [sprint-5/WARMDOWN.md](./sprint-5/WARMDOWN.md) |
| 6 | complete | 2026-06-01 | [sprint-6/WARMDOWN.md](./sprint-6/WARMDOWN.md) |
| 7 | complete | 2026-06-01 | [sprint-7/WARMDOWN.md](./sprint-7/WARMDOWN.md) |

**🏁 Program complete — WBS Sprints 0–7 all shipped. No Sprint 8.**

When a sprint completes, append a row here from `WARMDOWN.md`.

## Backlog deltas this project life

`(none)`

## Open RFC amendments

`(none — RFC rev4 Approved; any divergence found during a sprint amends `rfcs/whatsapp-engagement/` in the same sprint)`

---

## How to use this file

- A new session reads this file **first** to know which sprint is active and which sections of which docs are load-bearing right now.
- The session running a sprint **does not edit this file mid-sprint**. Updates land at warm-down.
- At warm-down, the session updates: active sprint pointer, load-bearing reading for the next sprint, last-completed fields, sprint history table, backlog deltas, and any open RFC amendments.
