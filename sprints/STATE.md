# Project State

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down.

---

## Active sprint

**Sprint number:** `4`
**Sprint name:** Handoff & consent
**Status:** `not-started`
**Goal:** A human-owned conversation suppresses the bot on inbound and resumes on release; un-opted-in/STOP customers are never messaged.
**WBS section:** [`sprints/WBS.md` § Sprint 4](./WBS.md)

## Build branch

**Active build branch:** `plan/whatsapp-engagement`

Every sprint session — manager and IC — works **on this branch only**. Before Step 1, confirm `git branch --show-current` matches. All story commits (`[S{N}-{nn}]`), fix-pass (`[S{N}-fix]`), and closeout (`[S{N}-close]`) land here. Do **not** commit to `main` mid-sprint unless this field is explicitly changed to `main`.

At session start: `git checkout plan/whatsapp-engagement` (or `git fetch && git checkout plan/whatsapp-engagement` if missing locally).

## Load-bearing reading for sprint 4

The session running sprint 4 must read these in this order before delegating any story:

1. `sprints/sprint-3/HANDOFF.md` — read-me-first; state of the world + Sprint 4 traps.
2. `sprints/WBS.md` § Sprint 4 — the plan for this sprint.
3. `sprints/SESSION_KICKOFF_PROMPT.md` — the loop you are running.
4. `rfcs/whatsapp-engagement/02-requirements-interfaces.md` — §4.7 (`OwnershipStore`/`ConsentStore`/`ownershipGate`/`consentGate`), §4.11 (inbound ownership gate + handoff-to-human seam); REQ-10/11/21.
5. `rfcs/whatsapp-engagement/03-pseudocode-blueprint.md` — §6.1 (consent/ownership gates), §6.5 (inbound ownership gate before `runtime.run`).
6. `rfcs/whatsapp-engagement/04-tasks-validation.md` — Phase D chunks (D1/D2) + §9.1 tests (`human_owned_inbound_does_not_run_flow`, `not_opted_in_blocks_send`, `stop_opts_out_and_halts_drip`).
7. `rfcs/whatsapp-engagement/05-security-rollback-open-qs.md` — R-08 (inbound ownership gate; outbound suppression insufficient).
8. Source: `packages/kuralle-messaging/src/adapter/createMessagingRouter.ts` (inbound gate before `runtime.run` in `onMessage`), `packages/kuralle-core/src/runtime/Runtime.ts` (S0-05 `terminalHandoffTargets` — `escalate→'human'` pauses + emits `handoff`), `packages/kuralle-messaging/src/types/outbound.ts` (`SendOutcome.suppressed`; gates are `OutboundMiddleware`), the `SessionStore` interface (ownership/consent backing).
9. `~/.claude/projects/-Users-mithushancj-Documents-asyncdot-openscoped-aria-flow/memory/MEMORY.md` — standing rules (Bun usage, no-shortcuts, publish-together).

### Sprint-0..3 seams Sprint 4 builds on
- S0-05 terminal handoff: `escalate→'human'` pauses the run + emits a `handoff` stream part (no missing-agent throw) — the `ownershipGate` consumes it to `ownership.claim`.
- S0-02 `customerId` — consent is keyed by `customerId` (not thread); ownership/window by conversation (`threadId`).
- S1 pipeline + `config.outbound` middleware slot + `SendOutcome.suppressed` — `consentGate`/`ownershipGate` install before the terminal `windowGuard` and short-circuit to `suppressed`/`deferred`.
- `createMessagingRouter.onMessage` (S3 added the inbound resolver chain) — the inbound ownership gate runs in `onMessage` **before** `runtime.run`.

## Last completed sprint

`3` — Interactive fidelity

## Last completed at

`2026-06-01`

## Sprint history

| Sprint | Status | Completed at | Warmdown |
|--------|--------|--------------|----------|
| 0 | complete | 2026-06-01 | [sprint-0/WARMDOWN.md](./sprint-0/WARMDOWN.md) |
| 1 | complete | 2026-06-01 | [sprint-1/WARMDOWN.md](./sprint-1/WARMDOWN.md) |
| 2 | complete | 2026-06-01 | [sprint-2/WARMDOWN.md](./sprint-2/WARMDOWN.md) |
| 3 | complete | 2026-06-01 | [sprint-3/WARMDOWN.md](./sprint-3/WARMDOWN.md) |

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
