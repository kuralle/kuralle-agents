# Project State

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down.

---

## Active sprint

**Sprint number:** `1`
**Sprint name:** Window-safe pipeline
**Status:** `not-started`
**Goal:** Every non-template outbound traverses an `OutboundPipeline` whose non-removable `windowGuard` makes a closed-window free-form send impossible to leak (it defers), proven by a fake-client test.
**WBS section:** [`sprints/WBS.md` § Sprint 1](./WBS.md)

## Build branch

**Active build branch:** `plan/whatsapp-engagement`

Every sprint session — manager and IC — works **on this branch only**. Before Step 1, confirm `git branch --show-current` matches. All story commits (`[S{N}-{nn}]`), fix-pass (`[S{N}-fix]`), and closeout (`[S{N}-close]`) land here. Do **not** commit to `main` mid-sprint unless this field is explicitly changed to `main`.

At session start: `git checkout plan/whatsapp-engagement` (or `git fetch && git checkout plan/whatsapp-engagement` if missing locally).

## Load-bearing reading for sprint 1

The session running sprint 1 must read these in this order before delegating any story:

1. `sprints/sprint-0/HANDOFF.md` — read-me-first; state of the world + Sprint 1 traps.
2. `sprints/WBS.md` § Sprint 1 — the plan for this sprint.
3. `sprints/SESSION_KICKOFF_PROMPT.md` — the loop you are running.
4. `rfcs/whatsapp-engagement/02-requirements-interfaces.md` — §4.1 (OutboundPipeline/middleware/SendOutcome/WindowState), §4.2 (OutboundSink/OutboundTemplate/`isTemplateCapable`), §4.9 (WindowStore — built S0-04); REQ-1/2/3/16/17.
5. `rfcs/whatsapp-engagement/03-pseudocode-blueprint.md` — §6.1 (leak-guarantee pseudocode + bypass-closure note).
6. `rfcs/whatsapp-engagement/04-tasks-validation.md` — Phase A chunks (A1/A2/A3) + §9.1 tests (`window_closed_never_sends_freeform`, `window_guard_required`, `window_closed_blocks_media_and_interactive`, `fallback_and_custom_mapper_route_through_pipeline`).
7. `rfcs/whatsapp-engagement/05-security-rollback-open-qs.md` — R-01/R-02/R-02-S/R-09 (why the pipeline + non-removable guard + bypass closure).
8. Source the pipeline wires into: `packages/kuralle-messaging/src/adapter/{createMessagingRouter.ts,stream-mapper.ts,window-store.ts}`, `packages/kuralle-messaging/src/types/{adapter.ts,client.ts}`, `packages/kuralle-messaging-meta/src/whatsapp/client.ts` (`sendTextOrTemplate` ~287, the direct-send bypass to wrap).
9. `~/.claude/projects/-Users-mithushancj-Documents-asyncdot-openscoped-aria-flow/memory/MEMORY.md` — standing rules (Bun usage, no-shortcuts, publish-together).

### Sprint-0 seams Sprint 1 builds on
- `WindowStore`/`InMemoryWindowStore` (`messaging/src/adapter/window-store.ts`) — `windowGuard` reads `WindowStore.get`; fail-closed default already in place.
- `WindowState` value type — already exported from `window-store.ts`; do not redefine.
- `ChannelPolicy`/`ClosedWindowStrategy` + `webPolicy()` (`engagement/src/policy.ts`, `policies/web.ts`) — the `windowGuard` calls `policy.isWindowOpen`.

## Last completed sprint

`0` — Core seams & scaffold

## Last completed at

`2026-06-01`

## Sprint history

| Sprint | Status | Completed at | Warmdown |
|--------|--------|--------------|----------|
| 0 | complete | 2026-06-01 | [sprint-0/WARMDOWN.md](./sprint-0/WARMDOWN.md) |

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
