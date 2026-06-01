# Sprint 7 — Warm-down (FINAL — program complete)

> **Author:** Opus 4.8 (1M) · 2026-06-01 (long-running program mode).
> **Outcome:** Goal achieved — one bot answers on WhatsApp + Web + Instagram, window-safe; full §9 matrix green (1210 tests); publish-together dry-run clean. **The entire WBS (Sprints 0–7) is implemented.**

## 1. Goal recap
**Sprint goal:** The multi-platform example demonstrates one bot answering on WhatsApp + Web + Instagram, window-safe, with the full §9 test matrix green and a publish-together dry-run clean.
**Did we hit it?** **Yes.** `engagement({policies})` wires the channel-agnostic chain (`.bridge`→`createMessagingRouter`); the multi-platform example runs the SAME bot on three channels (`same_bot_across_channels`); README + docs guide ship; `typecheck:all` green; the §9 matrix is **1210 pass / 0 fail**; `pnpm publish -r --dry-run` clean (engagement@0.2.0 rewrites to the current graph, no split-pin, no `.map`, no real publish).

## 2. Stories shipped
| Story | Status | Commit | Demo |
|-------|--------|--------|------|
| S7-01 | Done | `fe6bb31` | [s7-01-tests.txt](./artifacts/s7-01-tests.txt) |
| S7-02 | Done | `1b4c22f` | [s7-02-tests.txt](./artifacts/s7-02-tests.txt) |
| S7-03 | Done | `7b97159` | [s7-03-release.txt](./artifacts/s7-03-release.txt) |
No slips; no fix-pass code change.

## 3. What's working
- **`engagement({policies})`** composes gates+recovery+renderer (windowGuard appended terminal by the router) + policy inbound resolver + stores — `engagement_composes_bridge`.
- **Same bot, 3 channels** — `same_bot_across_channels` (WA list / IG carousel / web buttons, same ids; identical id-routing).
- **Release-ready** — `typecheck:all` green; §9 matrix 1210/0; publish dry-run clean (no split-pin via `pnpm pack` check; no `.map`).
- **Docs** — engagement README + apps/docs guide.

## 4. Known issues
| ID | Description | Severity |
|----|-------------|----------|
| KI-7-01 | `pnpm publish -r --dry-run` shows only the new `engagement` package (others at registry versions); split-pin verified via `pnpm pack` rewrite instead. A true release bumps+publishes the whole changed graph together (`pnpm release`). | minor (env) |
| KI-7-02 | `.broadcasts` needs a caller-supplied `broadcastPipeline` (the example wires it). | minor (intended) |

No blockers/majors.

## 5. Decisions made
- **Decision:** `bridge.outbound` excludes `windowGuard` (router appends it terminal). **Source:** PLAN §0. **RFC amendment:** none.
- **Decision:** `.broadcasts` wired via caller-supplied `broadcastPipeline` (no policy-client exposure / no interface change). **Source:** PLAN §0 / brief-s7-01. **RFC amendment:** none.
- **Decision:** engagement 0.0.0 → 0.2.0 release-prep; split-pin verified via `pnpm pack`. **Source:** s7-03-release.txt. **RFC amendment:** none.

## 6. RFC amendments
None this sprint. (Q7 was resolved in Sprint 6 / `e08d66e`.)

## 7. Metrics (program totals)
- **Tests:** 1210 pass / 0 fail across core + messaging + messaging-meta + engagement (added this sprint: ~11 — engagement-wiring 5, same-bot 6).
- **`typecheck:all`:** green. **Publish dry-run:** clean.
- **Program diff (all 8 sprint sections):** ~30+ story/fix/close commits on `plan/whatsapp-engagement`; new package `@kuralle-agents/engagement`; additive changes to `core`/`messaging`/`messaging-meta`.

## 8. Backlog updates
Remaining backlog (per WBS §4, all intentionally deferred): BK-01 CRM UI, BK-02 team-inbox surface, BK-03 analytics, BK-04 no-code builder, BK-05 Messenger ChannelPolicy, BK-06 durable WindowStore/BroadcastLedger.

## 9. Retrospective (program)
### Keep
The proceed-evidence loop with **independent manager re-verification** (read the diff, re-run the suites, inspect the test *assertions*) caught the quality nuances at every gate — and at the release gate it confirmed the IC's honest split-pin/§9-count work rather than rubber-stamping. The proof-schema cheat-sheet (added after Sprint 0) made every proof clean first-try from Sprint 1 on. Carrying explicit `§0 Decisions` into each PLAN resolved the under-specified RFC seams (StrategistInput, tagged-text, .broadcasts, ChoiceOption relocation) without mid-flight churn.
### Change
Two briefs forbade touching a component that the dependent behavior genuinely required changing (the windowGuard tagged-text line, S6). Lesson: when forbidding a change, also state the intended mechanism for the dependent behavior. The multi-path `bun test` under-discovery gotcha (S7-03) means whole-sprint gates should run package suites sequentially, not as one 4-path invocation.
### Try next (post-program)
Before a real publish: run `pnpm release` (version+publish the whole `@kuralle-agents/*` graph together), execute a live multi-platform smoke (not just the offline fake-client — per the repo's "run examples, typecheck isn't enough" gotcha), and address BK-06 (durable WindowStore + BroadcastLedger) for multi-process correctness.

## 10. Pointers (post-program)
- **Merge to trunk:** the build branch `plan/whatsapp-engagement` is ready for a PR to `main` (all sprints closed, 1210 tests green, typecheck:all green, dry-run clean). The PR is the trunk-merge step (CLAUDE.md: merge via PR after the sprint ships, not story-by-story on main).
- **Before publishing:** `pnpm release` for the whole changed graph; live smoke the multi-platform example with sandbox creds.
- **Open RFC amendments:** none. **Open blockers:** none.

## 11. Closeout
- [x] Stories committed (S7-01..03). [x] No `Apply now`. [x] HANDOFF (local) written. [x] STATE marked program-complete. [x] Artifacts archived.
**Sprint 7 is closed. The Kuralle Engagement program (WBS Sprints 0–7) is COMPLETE.**
