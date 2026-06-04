# Sprint 2 — Warm-down

> **Author:** Opus 4.8 (1M) · 2026-06-05. **Window:** 2026-06-05 (continued session).
> **Outcome:** Goal achieved — `VoiceDriver` streams the native-realtime transcript via the shared `speakGated`, barge-in preserved, and the whole-answer gate runs honestly post-hoc (REQ-9, advisory). Full suite green; `typecheck:all` no-new-failures.

## 1. Goal recap
**Goal:** Route `VoiceDriver` through `speakGated` (transcript-backed `TokenSource`); incremental streaming; honest post-hoc gate (REQ-9); barge-in/truncate preserved.
**Hit it?** **Yes.** S2-01 streams (>1 delta) with barge-in intact; S2-02 makes the native-realtime gate advisory (safety event + correction, never "blocked before emission"), documented in the voice README.

## 2. Stories shipped
| Story | Commit | Notes |
|-------|--------|-------|
| S2-prep | `5edc061` | VoiceDriver understanding map (`/code-understand`) |
| S2-01 | `71d80c8` | Transcript `TokenSource` (push-to-pull `deferredTokenSource`); >1 delta; barge-in preserved; REQ-12 |
| S2-02 | `54464b0` | Honest post-hoc gate (REQ-9): `safety-blocked` + correction request + `gateScope:'advisory'`; README |

## 3. What's working
- Native-realtime assistant transcript streams incrementally (>1 `text-delta`/turn) in the fake-client test.
- Barge-in: interrupt yields `truncateToHeard` heard prefix; existing voice suite green (12/0).
- Post-hoc gate is advisory (REQ-9): emits `safety-blocked`/`pipeline-validation-block`, requests a provider correction (graceful if unsupported), records `gateScope:'advisory'`; no code/doc claims native audio was blocked-before-emission.
- Extraction (`waitForUserTurn`) still silent (REQ-12).

## 4. Known issues
| ID | Description | Severity | Tracking |
|----|-------------|----------|----------|
| KI-2-01 | `typecheck:all` RED on the 4 pre-existing baseline configs (unchanged). | major | B-06 (Sprint 4) |
| KI-2-02 | Gemini transcript may double-fire (parts + cumulative `outputTranscription`); current accumulation preserved — live validation needed. | minor | **B-08** |
| KI-2-03 | `safety-blocked`/`pipeline-validation-block` added to `HarnessStreamPart` — add a one-line RFC §4.2 note at Sprint-4 docs pass. | nit | Sprint 4 docs |
| KI-2-04 | Interrupted turn surfaces streamed deltas + a fresh-id `truncateToHeard` trio (double-surface). Honest for native realtime; not a REQ-7 breach. | nit | — |

## 5. Decisions (O1–O3)
- **O1:** TokenSource preserves current `onTranscript` accumulation (no new dedup); live double-fire check = B-08.
- **O2:** `speakGated` provider-agnostic; `VoiceDriver` emits safety events + correction post-hoc.
- **O3:** correction via `client.requestResponse?.(...)` (optional-chained, graceful); offline test asserts the request, not audio.

## 6. RFC amendments
None this sprint (the `HarnessStreamPart` safety-variant addition is a code-level public-surface growth; a one-line RFC §4.2 note is queued for the Sprint-4 docs pass — KI-2-03).

## 7. Metrics
- Commits: 4 (S2-prep + S2-01 + S2-02 + close). New: `deferredTokenSource.ts`, `posthoc-gate.test.ts`, `streaming.test.ts`, fake-client correction support.
- Behavior: voice text now streams; gate advisory on native realtime.

## 8. Backlog updates
**Added:** B-08 (live-Gemini transcript double-fire validation). **Promoted:** none. **Removed:** none.

## 9. Retrospective
**Keep:** the `/code-understand` map nailed REQ-9 (audio bypasses Kuralle) with file:line evidence before briefing — the honesty implementation followed directly. Manager directly verified the honesty grep + barge-in code rather than trusting the proof.
**Change:** nothing major; proofs were well-formed this sprint.
**Try next (Sprint 3):** the cascaded adapter already forwards multiple deltas + handles cancel (from S1-fix). Sprint 3 = consume `.delta` for TTFT + prove first-chunk-before-turn-end with a metric. **Honor the §11 abort: if TTFT does not improve, STOP and re-diagnose — do not paper over.** `/delegate-review` recommended.

## 10. Pointers for the next sprint
- Read first: `KuralleRuntimeLLMAdapter.ts` (the cascaded run loop — already `.delta` + cancel from S1-fix; now wire `recordTtftOnce` to the FIRST delta), `kuralle-livekit-plugin-transport-ws/test/e2e/ws-cascaded-e2e.ts` (the e2e to extend), the `aria_runtime_ttft` metric.
- Trap: TTFT must measurably drop (first-token, not whole-turn). If something upstream still buffers, the metric won't move → §11 abort + re-diagnose.

## 11. Closeout
- [x] S2-01 + S2-02 PROCEED; manager review (`review-sprint.md`) Approve, no fix pass.
- [x] B-08 added to WBS §4.
- [x] WARMDOWN + HANDOFF written; STATE → Sprint 3.

Sprint 2 is closed.
