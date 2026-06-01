# Project State

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down.

---

## Active sprint

**Sprint number:** `2`
**Sprint name:** Smart-send strategist
**Status:** `not-started`
**Goal:** A closed-window free-form send is converted to an APPROVED template by an injectable strategist (mock selector) behind deterministic guardrails, or deferred — with an audit record per conversion.
**WBS section:** [`sprints/WBS.md` § Sprint 2](./WBS.md)

## Build branch

**Active build branch:** `plan/whatsapp-engagement`

Every sprint session — manager and IC — works **on this branch only**. Before Step 1, confirm `git branch --show-current` matches. All story commits (`[S{N}-{nn}]`), fix-pass (`[S{N}-fix]`), and closeout (`[S{N}-close]`) land here. Do **not** commit to `main` mid-sprint unless this field is explicitly changed to `main`.

At session start: `git checkout plan/whatsapp-engagement` (or `git fetch && git checkout plan/whatsapp-engagement` if missing locally).

## Load-bearing reading for sprint 2

The session running sprint 2 must read these in this order before delegating any story:

1. `sprints/sprint-1/HANDOFF.md` — read-me-first; state of the world + Sprint 2 traps.
2. `sprints/WBS.md` § Sprint 2 — the plan for this sprint.
3. `sprints/SESSION_KICKOFF_PROMPT.md` — the loop you are running.
4. `rfcs/whatsapp-engagement/02-requirements-interfaces.md` — §4.4 (`SmartSendStrategist`/`TemplateSelector`/`TemplateCatalog`/`TemplateDescriptor`/`AuditSink`/`createSmartSendStrategist`/`strategistMiddleware`); REQ-4/5/6.
5. `rfcs/whatsapp-engagement/03-pseudocode-blueprint.md` — §6.2 (strategist: guardrails OUTSIDE the AI).
6. `rfcs/whatsapp-engagement/04-tasks-validation.md` — Phase B chunks (B1/B2/B3) + §9.1 tests (`strategist_filters_paused_templates`, `strategist_defers_on_bad_params`, `strategist_audits_conversion`, `window_open_sends_freeform_no_selector_call`).
7. `rfcs/whatsapp-engagement/05-security-rollback-open-qs.md` — R-10 (component-aware `OutboundTemplate`; `TemplateInfo` lacks quality/paused).
8. Source: `packages/kuralle-engagement/src/policy.ts` (`SmartSendStrategist` placeholder `TODO(S2-01)`; `ClosedWindowStrategy{kind:'template',strategist}`), `packages/kuralle-messaging/src/types/outbound.ts` (`OutboundTemplate` → component-aware in B2; `OutboundMeta.window`), `packages/kuralle-messaging/src/adapter/middleware/window-guard.ts` (Sprint 1 defers; Sprint 2 wires the strategist), `packages/kuralle-messaging-meta/src/whatsapp/{types.ts (TemplateInfo ~367, TemplateComponent ~110),templates.ts,client.ts (sendTemplate ~268)}`.
9. `~/.claude/projects/-Users-mithushancj-Documents-asyncdot-openscoped-aria-flow/memory/MEMORY.md` — standing rules (Bun usage, no-shortcuts, publish-together).

### Sprint-0/1 seams Sprint 2 builds on
- `OutboundPipeline` + `windowGuard` (`messaging/src/adapter/{outbound-pipeline.ts,middleware/window-guard.ts}`) — Sprint 1 **defers** on a closed window; Sprint 2 adds the strategist the closed-window path hands off to (`strategistMiddleware` before the terminal `windowGuard`, or the guard delegates). Keep `windowGuard` terminal.
- `OutboundTemplate` / `OutboundSink` / `isTemplateCapable` (`messaging/src/types/outbound.ts`) — make `OutboundTemplate` component-aware (B2) and reconcile with WhatsApp `TemplateMessage` when a template flows.
- `SmartSendStrategist` placeholder + `ClosedWindowStrategy{kind:'template',strategist}` (`engagement/src/policy.ts`) — replace the `TODO(S2-01)` stub with the real §4.4 interface.

## Last completed sprint

`1` — Window-safe pipeline

## Last completed at

`2026-06-01`

## Sprint history

| Sprint | Status | Completed at | Warmdown |
|--------|--------|--------------|----------|
| 0 | complete | 2026-06-01 | [sprint-0/WARMDOWN.md](./sprint-0/WARMDOWN.md) |
| 1 | complete | 2026-06-01 | [sprint-1/WARMDOWN.md](./sprint-1/WARMDOWN.md) |

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
