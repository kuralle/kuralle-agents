# Project State — AI-SDK-native `toUIMessageStream()`

> **Single source of truth for "where are we right now."** Updated at the end of every sprint warm-down. (Separate build OS from `sprints/`, which is the completed streaming-by-default build — do not confuse the two.)

---

## Active sprint

**Sprint number:** `0`
**Sprint name:** Types & module
**Status:** `not-started`
**Goal:** Ship `KuralleDataParts` + `KuralleUIMessage` types and the `ai-sdk/uiMessageStream.ts` module skeleton as additive, tested code — repo green, no behavior change, nothing wired.
**WBS section:** [`sprints-uimessage/WBS.md` § Sprint 0](./WBS.md)

## Build branch

**Active build branch:** `plan/ai-sdk-native-uimessage`

Cut from `main` (which holds 0.4.1) at the start of Sprint 0: `git checkout main && git pull && git checkout -b plan/ai-sdk-native-uimessage`. Later sessions: `git checkout plan/ai-sdk-native-uimessage`. All story (`[S{N}-{nn}]`), fix (`[S{N}-fix]`), and closeout (`[S{N}-close]`) commits land here. Merge to `main` via a single PR after Sprint 4, paired with the `0.5.0` release. **Sprint 3 also touches the separate `kuralle-starters` repo (its own branch) — see WBS § Sprint 3.**

## Load-bearing reading for sprint 0

1. `sprints-uimessage/WBS.md` — full read; the plan.
2. `sprints-uimessage/SESSION_KICKOFF_PROMPT.md` — the loop you are running.
3. `docs/rfc-ai-sdk-native-uimessage-stream.md` — the source RFC. For Sprint 0: §4.1 (types), §2.1 (verified AI SDK API), REQ-5/10.
4. `packages/kuralle-core/src/types/stream.ts` — the full `HarnessStreamPart` union the adapter maps from.
5. `packages/kuralle-core/src/events/TurnHandle.ts` — where `toResponseStream` lives (the convenience `toUIMessageStreamResponse` lands alongside in Sprint 1).
6. Verify the `ai@^6` `UIMessage`/`createUIMessageStream` shapes against the installed version (Context7 `/vercel/ai` or `node_modules/ai`), not memory — the SDK churns.

## Last completed sprint
`(none — build not started)`

## Last completed at
`(none)`

## Sprint history

| Sprint | Status | Completed at | Warmdown |
|--------|--------|--------------|----------|
| 0 | not-started | — | — |

## Backlog deltas this project life
`(none — see WBS §4 for the starting backlog: BU-01..BU-04)`

## Open RFC amendments
`(none)`

---

## How to use this file
- A new session reads this file **first** to know the active sprint + load-bearing docs.
- The running session does **not** edit mid-sprint; updates land at warm-down (active pointer, build branch if changed, load-bearing reading for N+1, last-completed, history, backlog deltas, open amendments).
