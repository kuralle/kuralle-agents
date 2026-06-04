# Project State

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down.

---

## Active sprint

**Sprint number:** `2`
**Sprint name:** Voice (native realtime)
**Status:** `not-started`
**Goal:** Route `VoiceDriver` through `speakGated` via a transcript-backed `TokenSource` so the native realtime assistant transcript streams incrementally, with the whole-answer gate running honestly post-hoc (REQ-9) and barge-in/truncate preserved.
**WBS section:** [`sprints/WBS.md` § Sprint 2](./WBS.md)

## Build branch

**Active build branch:** `plan/streaming-by-default`

Every sprint session — manager and IC — works **on this branch only**. Before Step 1 of the kickoff, confirm `git branch --show-current` matches. All story commits (`[S{N}-{nn}]`), fix-pass (`[S{N}-fix]`), and closeout (`[S{N}-close]`) land here. Do **not** commit to `main` mid-sprint. Merge to `main` happens via a single PR after Sprint 4, paired with the real `pnpm release`.

At session start: `git checkout plan/streaming-by-default` (or, for the very first Sprint 0 session, cut it: `git checkout main && git pull && git checkout -b plan/streaming-by-default`).

## Load-bearing reading for sprint 2

The session running sprint 2 must read these in this order before delegating any story:

1. `sprints/sprint-1/HANDOFF.md` — read-me-first; current state + Sprint-2 traps (esp. REQ-9).
2. `sprints/WBS.md` § Sprint 2 — stories S2-01 (transcript `TokenSource`), S2-02 (honest post-hoc gate).
3. `docs/rfc-streaming-by-default.md` — §2.4 (two voice substrates), §5.1 (VoiceDriver), §10 (security), REQ-8, **REQ-9 (native-realtime honesty — defining constraint)**.
4. `packages/kuralle-core/src/runtime/channels/VoiceDriver.ts` — accumulate-then-emit block (now emitting the trio) to replace; preserve `heardCharCount`/`truncateAt`/barge-in.
5. `packages/kuralle-core/src/runtime/channels/streaming/speakGated.ts` — the shared path; build a transcript-backed `TokenSource` over `onTranscript`.
6. The `@kuralle-agents/realtime-audio` `RealtimeAudioClient` (`onTranscript`, `heardCharCount`, barge-in/`onInterrupted`) — the source of voice transcript events.
7. **Before S2-01:** `/code-understand` the realtime client transcript/barge-in path; link `.understanding/<slug>.md` in the S2-01 brief.

**Gate note:** `typecheck:all` is RED at baseline (4 frozen configs — see `sprint-0/PLAN.md §0` / WBS B-06). Use the frozen-baseline guard (`sprint-1/artifacts/guard-stream-s1-01.sh`) to assert "no NEW failures," not "exit 0." Grep migrations across `*.ts` AND `*.js`/`*.mjs`.

## Last completed sprint

`1` — Protocol flip + text path

## Last completed at

`2026-06-05`

## Sprint history

| Sprint | Status | Completed at | Warmdown |
|--------|--------|--------------|----------|
| 0 | done | 2026-06-05 | [sprint-0/WARMDOWN.md](./sprint-0/WARMDOWN.md) |
| 1 | done | 2026-06-05 | [sprint-1/WARMDOWN.md](./sprint-1/WARMDOWN.md) |
| 2 | not-started | — | — |

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
