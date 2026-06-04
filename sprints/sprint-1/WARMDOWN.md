# Sprint 1 — Warm-down

> **Author:** Opus 4.8 (1M) · 2026-06-05. **Window:** 2026-06-05 (continued session).
> **Outcome:** Goal achieved — the breaking lifecycle protocol shipped across all consumers and `TextDriver` streams via the shared `speakGated`; ungated replies emit >1 delta before turn-end, grounded nodes buffer, full suite green, `typecheck:all` no-new-failures.

## 1. Goal recap
**Goal:** Replace single-shot `text-delta` with the four-variant lifecycle across both unions and route `TextDriver` through `speakGated` (ungated → multi-delta; grounded → buffered); `typecheck:all` (no new) + `test` green.
**Hit it?** **Yes.** Breaking flip atomic across ~70 sites; `speakGated` + `TextDriver` streaming live; REQ-1/3/7/12 proven by test. The one nuance vs the WBS wording: a third union (`AgentStreamPart`) was in scope (O1) — RFC amended.

## 2. Stories shipped
| Story | Commit | Notes |
|-------|--------|-------|
| S1-01 | `c1c41fe` | Breaking flip + migrate all 86 sites; 3 unions; RFC §4.2.1/REQ-6 amended; B-07 logged |
| S1-02 | `245f2cc` | `speakGated` + `TokenSource`; hard invariant (blocked sentence absent) proven |
| S1-03 | `738d3e2` | `TextDriver` on shared path; >1 delta before turn-end (REQ-1); tool loop preserved |
| S1-fix | `0a65cad` | Phase B fix pass — 4 codex findings resolved |

## 3. What's working
- Ungated text reply streams multiple `text-delta{id,delta}` with the first before `turn-end` (`textdriver.test.ts:211-237`).
- Grounded/turn-mode node buffers to one message (REQ-3); extraction emits zero text events (REQ-12).
- `speakGated` gates each sentence before emit — blocked text never reaches the stream (RFC §11 invariant, asserted exact + substring).
- All 8 packages compile against the new protocol; full `test` green; `typecheck:all` no new failures over the 4 frozen baseline configs.
- Cascaded + CF adapters discard canceled turns (`text-cancel`).

## 4. What's not working / known issues
| ID | Description | Severity | Owner | Tracking |
|----|-------------|----------|-------|----------|
| KI-1-01 | `typecheck:all` still RED on the 4 pre-existing baseline configs (unchanged). | major | Sprint 4 | B-06 |
| KI-1-02 | `Hook.onStreamPart`/`AgentStreamPart` may be a dead public surface (no live emit feeds it) — flipped for consistency, not removed. | minor | post-0.4.0 | B-07 |
| KI-1-03 | True cascaded per-delta TTFT streaming + metric NOT done (adapter forwards deltas + handles cancel, but TTFT measurement deferred). | expected | Sprint 3 | WBS §Sprint 3 |
| KI-1-04 | Native realtime voice (`VoiceDriver`) flipped to new shape but still buffered (one delta per message) — true incremental streaming is Sprint 2. | expected | Sprint 2 | WBS §Sprint 2 |
| KI-1-05 | `SentenceAggregator` `MIN_WORDS...=3` heuristic still present (Sprint-0 m1); re-evaluate when a real sentence-granularity gate exists. | minor | when sentence-gate ships | S0 review m1 |

## 5. Decisions made (O1–O4)
- **O1:** `AgentStreamPart` (3rd union) flipped too — RFC §4.2.1/REQ-6 amended (no dual-shape, REQ-11). B-07 logged.
- **O2:** `SAFE_EVENT_TYPES` gained `text-start`/`text-end`/`text-cancel`.
- **O3:** cascaded adapter compile-only + cancel-handling in S1; TTFT streaming deferred to Sprint 3.
- **O4:** one-shot messages each emit a self-contained `start/delta/end` trio with a fresh uuid (consistent with RFC §7).

## 6. RFC amendments this sprint
`docs/rfc-streaming-by-default.md`: REQ-6 updated to name **all three** unions; new **§4.2.1** documents `AgentStreamPart` inclusion with rationale. WBS §4: **B-07** added.

## 7. Metrics
- Commits: 4 (S1-01/02/03 + S1-fix). S1-01 touched 86 files (+294/−157).
- Tests added: `speakGated.modes` (7), `textdriver` streaming (+), cascaded adapter cancel (+), CF StreamAdapter (+78), aggregator lossless assertion. Full suite green.
- Behavior: text now streams; voice/cascaded still buffered (by plan).

## 8. Backlog updates
**Added:** B-07 (possible dead `Hook.onStreamPart`/`AgentStreamPart` surface). **Promoted:** none. **Removed:** none.

## 9. Retrospective
**Keep:** the pre-brief consumer map (`/code-understand`) + the self-enforcing gate (no-new-typecheck + full-test) made the 70-site breaking flip provably complete. `/delegate-review` caught 4 real latent defects.
**Change:** the grep-clean used `--include=*.ts` and missed `.js/.mjs` consumers (codex caught it). Future migration stories must grep ALL runnable extensions. Cursor's proof-JSON hygiene was unreliable twice — keep relying on independent manager re-verification, not the proof alone.
**Try next (Sprint 2):** before briefing `VoiceDriver`, `/code-understand` the `onTranscript`/`heardCharCount`/barge-in path — REQ-9's honesty constraint (post-hoc gate on native realtime) is the trap; assert the docs/code never claim "blocked before emission" for native audio.

## 10. Pointers for the next sprint
- Read first: `VoiceDriver.ts` (the accumulate-then-emit block now emitting the trio), `RealtimeAudioClient.ts` (`onTranscript`, `heardCharCount`, `truncateAt`, barge-in), `speakGated.ts` (the shared path to plug into).
- Trap: native realtime provider speaks audio before any Kuralle gate → the whole-answer gate is POST-HOC (REQ-9). Tests + README must say it is advisory, never "blocked-before-emit".
- `speakGated`'s `TokenSource` is the integration point — `VoiceDriver` builds a transcript-backed source.

## 11. Closeout
- [x] All stories committed atomically on `plan/streaming-by-default`.
- [x] Phase B: `/delegate-review` (codex, not-ready → 4 findings) + `[S1-fix]` + manager sandwich review (`review-sprint.md`) — Approve, fixes applied.
- [x] RFC amended (§4.2.1/REQ-6); WBS B-07 added.
- [x] WARMDOWN + HANDOFF written; STATE → Sprint 2 with load-bearing reading.

Sprint 1 is closed.
