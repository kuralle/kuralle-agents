# Project State

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down.

---

## Active sprint

**Sprint number:** `1`
**Sprint name:** Protocol flip + text path
**Status:** `not-started`
**Goal:** Replace the single-shot `text-delta` with the `text-start`/`text-delta{id,delta}`/`text-end`/`text-cancel` lifecycle across both unions and route `TextDriver` through `speakGated`, so an ungated text reply emits more than one delta before turn-end while a grounded node still buffers — `typecheck:all` (no new failures) and `test` green at close.
**WBS section:** [`sprints/WBS.md` § Sprint 1](./WBS.md)

## Build branch

**Active build branch:** `plan/streaming-by-default`

Every sprint session — manager and IC — works **on this branch only**. Before Step 1 of the kickoff, confirm `git branch --show-current` matches. All story commits (`[S{N}-{nn}]`), fix-pass (`[S{N}-fix]`), and closeout (`[S{N}-close]`) land here. Do **not** commit to `main` mid-sprint. Merge to `main` happens via a single PR after Sprint 4, paired with the real `pnpm release`.

At session start: `git checkout plan/streaming-by-default` (or, for the very first Sprint 0 session, cut it: `git checkout main && git pull && git checkout -b plan/streaming-by-default`).

## Load-bearing reading for sprint 1

The session running sprint 1 must read these in this order before delegating any story:

1. `sprints/sprint-0/HANDOFF.md` — read-me-first; current state + Sprint-1 traps.
2. `sprints/WBS.md` § Sprint 1 — stories S1-01/02/03.
3. `docs/rfc-streaming-by-default.md` — §4.1–4.2 (lifecycle events, REQ-6/7), §4.5 (`speakGated`+`TokenSource`), §5.1 (TextDriver), §6 (pseudocode), §7 (blueprint), §11 (abort criteria).
4. `packages/kuralle-core/src/types/stream.ts` + `types/voice.ts` — the two unions to flip (breaking).
5. `packages/kuralle-core/src/runtime/channels/TextDriver.ts:58-147` — the accumulate-then-emit block to replace with `speakGated`.
6. `packages/kuralle-core/src/runtime/policies/agentTurn.ts:236-272` — `applyPostTurnPolicies`, which becomes `speakGated`'s `runGate`.
7. Sprint-0 primitives now available to wire: `runtime/channels/streaming/{mode.ts,SentenceAggregator.ts}`.
8. **Before S1-01:** run `/code-understand` on the `HarnessStreamPart`/voice-union **consumers** (breaking-flip blast radius) and link `.understanding/<slug>.md` in the S1-01 brief.

**Gate note:** `typecheck:all` is RED at baseline (4 frozen configs — see `sprint-0/PLAN.md §0` / WBS B-06). Use the frozen-baseline guard pattern (`sprint-0/artifacts/guard-stream-s0-01.sh`) to assert "no NEW failures," not "exit 0."

## Last completed sprint

`0` — Primitives

## Last completed at

`2026-06-05`

## Sprint history

| Sprint | Status | Completed at | Warmdown |
|--------|--------|--------------|----------|
| 0 | done | 2026-06-05 | [sprint-0/WARMDOWN.md](./sprint-0/WARMDOWN.md) |
| 1 | not-started | — | — |

When a sprint completes, append a row here from `WARMDOWN.md`.

## Backlog deltas this project life

- **B-06** added (Sprint 0): fix pre-existing `typecheck:all` drift in test/example files (4 configs/14 errors); release blocker before Sprint 4's `0.4.0` gate. See WBS §4.

## Open RFC amendments

`(none)`

---

## How to use this file

- A new session reads this file **first** to know which sprint is active and which sections of which docs are load-bearing right now.
- The session running a sprint **does not edit this file mid-sprint**. Updates land at warm-down.
- At warm-down, the session updates: active sprint pointer, **build branch** (only if it changed), load-bearing reading for the next sprint, last-completed fields, sprint history table, backlog deltas, and any open RFC amendments.
