# Project State

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down.

---

## Active sprint

**Sprint number:** `6`
**Sprint name:** Channel adapters
**Status:** `not-started`
**Goal:** The same bot runs on WhatsApp and Instagram via injected `ChannelPolicy` adapters (web already from Sprint 0), each rendering/recovering per its channel rules.
**WBS section:** [`sprints/WBS.md` § Sprint 6](./WBS.md)

> **Sprint 6 note:** S6-02 is a HARD verification gate (Q7) — re-verify Instagram specifics against current Meta docs before building G2; flag via `/grill-me` if Meta diverges from the RFC assumption.

## Build branch

**Active build branch:** `plan/whatsapp-engagement`

Every sprint session — manager and IC — works **on this branch only**. Before Step 1, confirm `git branch --show-current` matches. All story commits (`[S{N}-{nn}]`), fix-pass (`[S{N}-fix]`), and closeout (`[S{N}-close]`) land here. Do **not** commit to `main` mid-sprint unless this field is explicitly changed to `main`.

At session start: `git checkout plan/whatsapp-engagement` (or `git fetch && git checkout plan/whatsapp-engagement` if missing locally).

## Load-bearing reading for sprint 6

The session running sprint 6 must read these in this order before delegating any story:

1. `sprints/sprint-5/HANDOFF.md` — read-me-first; state of the world + Sprint 6 traps (esp. the S6-02 Q7 gate).
2. `sprints/WBS.md` § Sprint 6 — the plan for this sprint.
3. `sprints/SESSION_KICKOFF_PROMPT.md` — the loop you are running.
4. `rfcs/whatsapp-engagement/02-requirements-interfaces.md` — §4.12 (`ChannelPolicy` — WhatsApp/Web/Instagram adapter rows); REQ-22.
5. `rfcs/whatsapp-engagement/03-pseudocode-blueprint.md` — §6.1 (windowGuard via injected `policy`), §6.6 (omnichannel).
6. `rfcs/whatsapp-engagement/04-tasks-validation.md` — Phase G chunks (G1/G2) + §9.1 tests (`same_bot_across_channels`, `web_null_policy_always_open`, `instagram_closed_window_tags_or_defers`, `whatsapp_policy_unchanged_behavior`).
7. `rfcs/whatsapp-engagement/05-security-rollback-open-qs.md` — Q7 (Instagram constraints — **S6-02 verify vs current Meta docs**); RESEARCH §6.
8. Source: `packages/kuralle-engagement/src/policy.ts` (`ChannelPolicy`/`ClosedWindowStrategy`, S0-04), `packages/kuralle-messaging-meta/src/instagram/client.ts` (`sendTextWithTag` ~423, `sendButtonTemplate` ~186, `sendQuickReplies` ≤13 ~299, `sendGenericTemplate` ~323), `whatsapp/client.ts`, the windowGuard/interactiveRenderer/inbound-resolver (Sprint 6 makes them read the injected policy).
9. `~/.claude/projects/-Users-mithushancj-Documents-asyncdot-openscoped-aria-flow/memory/MEMORY.md` — standing rules (Bun usage, no-shortcuts, publish-together).

### Sprint-0..5 seams Sprint 6 builds on
- S0-04 `ChannelPolicy`/`ClosedWindowStrategy` + `webPolicy()` — G1/G2 implement real WhatsApp/Instagram policies; web already exists.
- S1 windowGuard/pipeline — Sprint 6 makes the guard read `policy.isWindowOpen`/`policy.closedWindow` (the rev3 unification) WITHOUT regressing the WhatsApp path (`whatsapp_policy_unchanged_behavior`).
- S2 strategist — the WhatsApp policy's `closedWindow:{kind:'template',strategist}`.
- S3 renderer/inbound-resolver — per-policy `renderInteractive`/`resolveInbound`.
- S4 consent/ownership — `consentRequired` per policy.

## Last completed sprint

`5` — Proactive outbound

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
