# Project State

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down.

---

## Active sprint

**Sprint number:** `5`
**Sprint name:** Proactive outbound
**Status:** `not-started`
**Goal:** A broadcast template is idempotent across retry and a reply hands into a flow; a drip stops on reply; re-engagement reopens the window and resumes the flow.
**WBS section:** [`sprints/WBS.md` § Sprint 5](./WBS.md)

## Build branch

**Active build branch:** `plan/whatsapp-engagement`

Every sprint session — manager and IC — works **on this branch only**. Before Step 1, confirm `git branch --show-current` matches. All story commits (`[S{N}-{nn}]`), fix-pass (`[S{N}-fix]`), and closeout (`[S{N}-close]`) land here. Do **not** commit to `main` mid-sprint unless this field is explicitly changed to `main`.

At session start: `git checkout plan/whatsapp-engagement` (or `git fetch && git checkout plan/whatsapp-engagement` if missing locally).

## Load-bearing reading for sprint 5

The session running sprint 5 must read these in this order before delegating any story:

1. `sprints/sprint-4/HANDOFF.md` — read-me-first; state of the world + Sprint 5 traps.
2. `sprints/WBS.md` § Sprint 5 — the plan for this sprint.
3. `sprints/SESSION_KICKOFF_PROMPT.md` — the loop you are running.
4. `rfcs/whatsapp-engagement/02-requirements-interfaces.md` — §4.7 (`Scheduler`, `BroadcastLedger`); REQ-12/13.
5. `rfcs/whatsapp-engagement/03-pseudocode-blueprint.md` — §6.5 (broadcast/drip pseudocode + the R-07 ledger note).
6. `rfcs/whatsapp-engagement/04-tasks-validation.md` — Phase E chunks (E1/E2/E3) + §9.1 tests (`broadcast_idempotent_and_reply_enters_flow`, `broadcast_ledger_idempotent_per_campaign_recipient`, `drip_stops_on_reply`, `reengagement_reopens_window_and_resumes`).
7. `rfcs/whatsapp-engagement/05-security-rollback-open-qs.md` — R-07 (explicit `BroadcastLedger`, NOT the per-run effect log; `runId==sessionId`).
8. Source: `packages/kuralle-engagement/src/` (new scheduler/broadcast/drip), `OutboundPipeline` (broadcast sends traverse it; consent/ownership/window gates apply), `engagement/src/consent.ts` (opted-in filter), `packages/kuralle-core/src/runtime/openRun.ts:31` (`runId == sessionId`), S2 strategist/catalog (approved templates), `messaging/src/adapter/window-store.ts` (re-engagement reopens window).
9. `~/.claude/projects/-Users-mithushancj-Documents-asyncdot-openscoped-aria-flow/memory/MEMORY.md` — standing rules (Bun usage, no-shortcuts, publish-together).

### Sprint-0..4 seams Sprint 5 builds on
- S1 `OutboundPipeline` — broadcast/drip sends traverse it (window/consent/ownership gates still apply); approved-template sends are window-agnostic.
- S2 strategist/catalog — broadcasts send APPROVED templates.
- S4 `ConsentStore` — broadcasts go only to opted-in recipients; STOP halts.
- S0-03 `RunOptions.selection` + the inbound router path — a recipient reply enters a flow via the normal inbound path.
- `runId == sessionId` (`openRun.ts:31`) — the per-run effect log dedupes WITHIN a conversation only, so broadcast idempotency needs the explicit `BroadcastLedger` (R-07).

## Last completed sprint

`4` — Handoff & consent

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
