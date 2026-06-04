# Project State

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down.

---

## Active sprint

**Sprint number:** `3`
**Sprint name:** Cascaded TTFT
**Status:** `not-started`
**Goal:** Make `KuralleRuntimeLLMStream.run` consume `text-delta.delta` and handle the lifecycle so the LiveKit cascaded path begins TTS before the runtime turn completes and `aria_runtime_ttft` drops to first-token latency.
**WBS section:** [`sprints/WBS.md` § Sprint 3](./WBS.md)

## Build branch

**Active build branch:** `plan/streaming-by-default`

Every sprint session — manager and IC — works **on this branch only**. Before Step 1 of the kickoff, confirm `git branch --show-current` matches. All story commits (`[S{N}-{nn}]`), fix-pass (`[S{N}-fix]`), and closeout (`[S{N}-close]`) land here. Do **not** commit to `main` mid-sprint. Merge to `main` happens via a single PR after Sprint 4, paired with the real `pnpm release`.

At session start: `git checkout plan/streaming-by-default` (or, for the very first Sprint 0 session, cut it: `git checkout main && git pull && git checkout -b plan/streaming-by-default`).

## Load-bearing reading for sprint 3

The session running sprint 3 must read these in this order before delegating any story:

1. `sprints/sprint-2/HANDOFF.md` — read-me-first; current state + Sprint-3 traps (esp. the §11 TTFT abort).
2. `sprints/WBS.md` § Sprint 3 — stories S3-01 (adapter lifecycle/TTFT), S3-02 (TTFT proof e2e).
3. `docs/rfc-streaming-by-default.md` — §7 (cascaded blueprint), REQ-10, §1 success criterion #2, **§11 abort criteria**.
4. `packages/kuralle-livekit-plugin/src/llm/KuralleRuntimeLLMAdapter.ts` — run loop (already `.delta` + `text-cancel` from S1-fix); `recordTtftOnce` must fire on the FIRST `text-delta`.
5. `packages/kuralle-livekit-plugin-transport-ws/test/e2e/ws-cascaded-e2e.ts` — the e2e to extend (first-chunk-before-turn-end + before/after `aria_runtime_ttft`).
6. **Before S3-01:** `/code-understand` the cascaded adapter + the `aria_runtime_ttft` metric path if unfamiliar; link the artifact in the brief.

**Gate note:** `typecheck:all` RED baseline (4 frozen configs — `sprint-0/PLAN.md §0` / B-06). Use the frozen-baseline guard (`sprint-1/artifacts/guard-stream-s1-01.sh`). Grep migrations across `*.ts`+`*.js`+`*.mjs`. **§11 ABORT:** if TTFT does not improve, STOP and surface it — do not work around.

## Last completed sprint

`2` — Voice (native realtime)

## Last completed at

`2026-06-05`

## Sprint history

| Sprint | Status | Completed at | Warmdown |
|--------|--------|--------------|----------|
| 0 | done | 2026-06-05 | [sprint-0/WARMDOWN.md](./sprint-0/WARMDOWN.md) |
| 1 | done | 2026-06-05 | [sprint-1/WARMDOWN.md](./sprint-1/WARMDOWN.md) |
| 2 | done | 2026-06-05 | [sprint-2/WARMDOWN.md](./sprint-2/WARMDOWN.md) |
| 3 | not-started | — | — |

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
