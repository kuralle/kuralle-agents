# `sprints-uimessage/` — build OS for the AI-SDK-native UIMessageStream RFC

This directory is a **self-contained sprint-driven build operating system** for `docs/rfc-ai-sdk-native-uimessage-stream.md` (additive `toUIMessageStream()` adapter + typed `data-kuralle-*` parts; targets `0.5.0`).

> **Separate from `sprints/`.** `sprints/` is the *completed* streaming-by-default build (shipped 0.4.0/0.4.1). This build is namespaced here so those records stay intact. Don't cross the streams.

## What's here
| File | Purpose |
|------|---------|
| `SESSION_KICKOFF_PROMPT.md` | Paste once at the repo root to run the long-running program session (sprint → warm-down → next). |
| `STATE.md` | Single source of truth for the active sprint + build branch + load-bearing reading. Read this first. |
| `WBS.md` | The plan — 5 sprints (0–4) across Types / Adapter / Server / Proof-consumer / Polish+0.5.0, each cited to the RFC. |
| `templates/` | Per-sprint artifacts: `PLAN`, `STORY-BRIEF`, `PROCEED-EVIDENCE`, `REVIEW-r1`, `WARMDOWN`, `HANDOFF`. |
| `sprint-N/` | Created per sprint by the running session (PLAN, proceed-*, review-sprint, WARMDOWN, HANDOFF, artifacts). |

## How to run
1. Open a session at the repo root.
2. Paste the contents of `sprints-uimessage/SESSION_KICKOFF_PROMPT.md`.
3. The session reads `STATE.md`, cuts/checks out `plan/ai-sdk-native-uimessage`, and advances sprint by sprint.

Resume in a new chat: paste the same prompt; read `STATE.md` + the latest `sprint-N/HANDOFF.md`.

## Build branch
`plan/ai-sdk-native-uimessage` (cut from `main` @ 0.4.1). Merge to `main` via one PR after Sprint 4 + the `0.5.0` release. Sprint 3's proof consumer lands in the separate `kuralle-starters` repo.
