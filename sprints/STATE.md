# Project State

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down.

---

## Active sprint

**Sprint number:** `0`
**Sprint name:** Core seams & scaffold
**Status:** `not-started`
**Goal:** Scaffold `@kuralle-agents/engagement` and land the additive core seams so a flow run threads a structured `selection` into flow state and `escalate→'human'` pauses (not throws), proven by unit tests.
**WBS section:** [`sprints/WBS.md` § Sprint 0](./WBS.md)

## Load-bearing reading for sprint 0

The session running sprint 0 must read these in this order before delegating any story:

1. `sprints/WBS.md` — full read; this is the plan.
2. `sprints/SESSION_KICKOFF_PROMPT.md` — the loop you are running.
3. `rfcs/whatsapp-engagement/02-requirements-interfaces.md` — §4.8 (RunOptions.selection), §4.9 (WindowStore), §4.10 (inbound types), §4.11 (identity + ownership), §4.12 (ChannelPolicy); REQ-19/20/22/23.
4. `rfcs/whatsapp-engagement/03-pseudocode-blueprint.md` — §6.3 (inbound resolution / selection).
5. `rfcs/whatsapp-engagement/04-tasks-validation.md` — Phase A0 chunks (A0.1–A0.5) + the §9 fail-to-pass tests for them.
6. `rfcs/whatsapp-engagement/05-security-rollback-open-qs.md` — rev2/rev3/rev4 revision notes (why each seam exists) + R-03/R-04/R-05/R-08-B.
7. Source code the seams touch: `packages/kuralle-core/src/runtime/{Runtime.ts,openRun.ts,ctx.ts}`, `packages/kuralle-messaging/src/{types/messages.ts,types/adapter.ts,adapter/session-resolver.ts,adapter/window-tracker.ts}`, `packages/kuralle-messaging-meta/src/whatsapp/client.ts` (`toInboundMessage` ~592).
8. `~/.claude/projects/-Users-mithushancj-Documents-asyncdot-openscoped-aria-flow/memory/MEMORY.md` — standing rules (Bun usage, no-shortcuts, publish-together).

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

`(none)`

## Open RFC amendments

`(none — RFC rev4 Approved; any divergence found during a sprint amends `rfcs/whatsapp-engagement/` in the same sprint)`

---

## How to use this file

- A new session reads this file **first** to know which sprint is active and which sections of which docs are load-bearing right now.
- The session running a sprint **does not edit this file mid-sprint**. Updates land at warm-down.
- At warm-down, the session updates: active sprint pointer, load-bearing reading for the next sprint, last-completed fields, sprint history table, backlog deltas, and any open RFC amendments.
