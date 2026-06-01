# Project State

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down.

---

## Active sprint

**Sprint number:** `3`
**Sprint name:** Interactive fidelity
**Status:** `not-started`
**Goal:** A `collect`/`decide` renders WhatsApp buttons/list and inbound button/list/`nfm_reply` routes the flow by stable id (label-independent), with free-text NLU fallback.
**WBS section:** [`sprints/WBS.md` § Sprint 3](./WBS.md)

## Build branch

**Active build branch:** `plan/whatsapp-engagement`

Every sprint session — manager and IC — works **on this branch only**. Before Step 1, confirm `git branch --show-current` matches. All story commits (`[S{N}-{nn}]`), fix-pass (`[S{N}-fix]`), and closeout (`[S{N}-close]`) land here. Do **not** commit to `main` mid-sprint unless this field is explicitly changed to `main`.

At session start: `git checkout plan/whatsapp-engagement` (or `git fetch && git checkout plan/whatsapp-engagement` if missing locally).

## Load-bearing reading for sprint 3

The session running sprint 3 must read these in this order before delegating any story:

1. `sprints/sprint-2/HANDOFF.md` — read-me-first; state of the world + Sprint 3 traps.
2. `sprints/WBS.md` § Sprint 3 — the plan for this sprint.
3. `sprints/SESSION_KICKOFF_PROMPT.md` — the loop you are running.
4. `rfcs/whatsapp-engagement/02-requirements-interfaces.md` — §4.3 (`InboundResolverChain`/`InteractiveResolver`/`TextResolver`/`ResolvedSelection`), §4.6 (additive `{type:'interactive'}` `HarnessStreamPart`), §4.5 (`withChoices`, `ChoiceOption`); REQ-7/8/9.
5. `rfcs/whatsapp-engagement/03-pseudocode-blueprint.md` — §6.3 (inbound resolution / stable-id routing), §6.4 (interactive render on node entry).
6. `rfcs/whatsapp-engagement/04-tasks-validation.md` — Phase C chunks (C1–C4) + §9.1 tests (`render_picks_buttons_then_list`, `renderer_rejects_over_limit`, `interactive_routes_by_id_not_label`, `template_button_payload_routes`, `nfm_reply_form_in_state`, `free_text_nlu_fallback`).
7. `rfcs/whatsapp-engagement/05-security-rollback-open-qs.md` — R-11 (renderer rejects over-limit, no silent slice).
8. Source: `packages/kuralle-core/src/types/stream.ts` (add the additive `interactive` variant — tracked risk; check `types/voice.ts` for a 2nd union), `packages/kuralle-core/src/flow/{flow.ts,runFlow.ts}` (choice metadata + emit on node entry), `packages/kuralle-engagement/src/policy.ts` (`ChoiceOption` — likely relocate to core), `packages/kuralle-messaging/src/adapter/createMessagingRouter.ts` (`input = message.text ?? '[type]'` → resolver chain; `RunOptions.selection` from S0-03), `packages/kuralle-messaging-meta/src/whatsapp/client.ts` (`toInboundMessage` button/`nfm_reply` from S0-02; renderer limits ~340).
9. `~/.claude/projects/-Users-mithushancj-Documents-asyncdot-openscoped-aria-flow/memory/MEMORY.md` — standing rules (Bun usage, no-shortcuts, publish-together).

### Sprint-0/1/2 seams Sprint 3 builds on
- `InboundMessage.button`/`interactive.formResponse`/`customerId` (S0-02) — the `InteractiveResolver` reads these (`toInboundMessage` already populates them).
- `RunOptions.selection` + `ResolvedSelection` in core (S0-03) — the resolver's `{input, selection}` propagates via `runtime.run({input, selection})`; `selection.formData` merges into flow state, `selection.id` is the routing input.
- `ChoiceOption` in `engagement/src/policy.ts` (S0-04) — relocate to `@kuralle-agents/core` for the stream variant (core can't import engagement); re-export from engagement. `webPolicy.renderInteractive` already maps `ChoiceOption[]`→buttons.
- `OutboundPipeline`/`windowGuard`/`strategistMiddleware` (S1/S2) — the interactive payload is a free-form `{kind:'interactive'}` that still traverses the window-safe pipeline.

## Last completed sprint

`2` — Smart-send strategist

## Last completed at

`2026-06-01`

## Sprint history

| Sprint | Status | Completed at | Warmdown |
|--------|--------|--------------|----------|
| 0 | complete | 2026-06-01 | [sprint-0/WARMDOWN.md](./sprint-0/WARMDOWN.md) |
| 1 | complete | 2026-06-01 | [sprint-1/WARMDOWN.md](./sprint-1/WARMDOWN.md) |
| 2 | complete | 2026-06-01 | [sprint-2/WARMDOWN.md](./sprint-2/WARMDOWN.md) |

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
