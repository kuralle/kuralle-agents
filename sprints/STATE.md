# Project State

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down.

---

## Active sprint

**Sprint number:** `0`
**Sprint name:** Primitives
**Status:** `not-started`
**Goal:** Ship `resolveStreamMode`, `SentenceAggregator`, and the `streamGranularity` gate field as additive, unit-tested modules — repo behavior unchanged, `typecheck:all` and `test` green.
**WBS section:** [`sprints/WBS.md` § Sprint 0](./WBS.md)

## Build branch

**Active build branch:** `plan/streaming-by-default`

Every sprint session — manager and IC — works **on this branch only**. Before Step 1 of the kickoff, confirm `git branch --show-current` matches. All story commits (`[S{N}-{nn}]`), fix-pass (`[S{N}-fix]`), and closeout (`[S{N}-close]`) land here. Do **not** commit to `main` mid-sprint. Merge to `main` happens via a single PR after Sprint 4, paired with the real `pnpm release`.

At session start: `git checkout plan/streaming-by-default` (or, for the very first Sprint 0 session, cut it: `git checkout main && git pull && git checkout -b plan/streaming-by-default`).

## Load-bearing reading for sprint 0

The session running sprint 0 must read these in this order before delegating any story:

1. `sprints/WBS.md` — full read; this is the plan.
2. `sprints/SESSION_KICKOFF_PROMPT.md` — the loop you are running.
3. `docs/rfc-streaming-by-default.md` — the source RFC. For Sprint 0, focus on §4.3 (`resolveStreamMode`), §4.4 (`SentenceAggregator`), §4.6 (`streamGranularity`), and REQ-2/4/5.
4. `packages/kuralle-core/src/runtime/policies/agentTurn.ts` — the post-turn gate the modes select over (`validationPolicies`, `outputProcessors`).
5. `packages/kuralle-core/src/runtime/grounding/index.ts` — where the node's whole-answer grounding scope lives (needed for the `turn`-mode predicate in S0-03).

## Last completed sprint

`(none — project not started)`

## Last completed at

`(none)`

## Sprint history

| Sprint | Status | Completed at | Warmdown |
|--------|--------|--------------|----------|
| 0 | not-started | — | — |

When a sprint completes, append a row here from `WARMDOWN.md`.

## Backlog deltas this project life

`(none — see WBS §4 for the starting backlog: B-01..B-05)`

## Open RFC amendments

`(none)`

---

## How to use this file

- A new session reads this file **first** to know which sprint is active and which sections of which docs are load-bearing right now.
- The session running a sprint **does not edit this file mid-sprint**. Updates land at warm-down.
- At warm-down, the session updates: active sprint pointer, **build branch** (only if it changed), load-bearing reading for the next sprint, last-completed fields, sprint history table, backlog deltas, and any open RFC amendments.
