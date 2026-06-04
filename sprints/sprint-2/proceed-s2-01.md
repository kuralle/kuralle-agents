# Proceed Evidence — `S2-01` VoiceDriver transcript TokenSource

> Manager artifact — Phase A.

## Story
- **Id:** `S2-01` · **Commit:** `71d80c8` · **IC slug:** `stream-s2-01` (cursor)

## Proceed checklist (manager — read interrupt path + tests directly)
- [x] `verify-handoff-proof.sh stream-s2-01` → `PROOF_OK` (3 claims, 5 assertions).
- [x] **Normal path streams via `speakGated`** (`VoiceDriver.ts:80` `speakPromise`, `:74` `resolveStreamMode`, `:76` `createDeferredTokenSource`); REQ-8 test asserts `deltas.length > 1` + first delta before turn-end (`streaming.test.ts:54,58`).
- [x] **Barge-in PRESERVED:** interrupt path (`VoiceDriver.ts:110-127`) closes the transcript source, cancels `speakGated`, then emits `truncateToHeard(draftText, heardCharCount)` (`:119`) + sets `out.truncateAt` (`:118`). `truncateToHeard` retained (`:336`). Existing voice/barge-in suite green (12/0).
- [x] **REQ-12:** extraction path emits zero text lifecycle events (`streaming.test.ts:124` `TEXT_LIFECYCLE.toHaveLength(0)`).
- [x] New `deferredTokenSource.ts` (push-to-pull adapter) + its test; `close()` on all terminal paths.
- [x] No suppression (0); scope clean (VoiceDriver, deferred-source + test, voice streaming test, fake-client helper, guard+artifact). No stray root files.

**Verdict:** `PROCEED`

## One-line summary
`VoiceDriver` normal path streams via a deferred transcript `TokenSource`+`speakGated` (>1 delta, REQ-8); barge-in/`truncateToHeard` preserved; extraction silent (REQ-12) · commit `71d80c8`.

## Notes (carry to S2-02 / review)
- Interrupt yields the already-streamed deltas (from `speakGated` before close) PLUS a fresh-id `truncateToHeard` trio. Different ids ⇒ not a REQ-7 violation. Honest for native realtime (audio already spoken, REQ-9). S2-02 review should confirm this double-surface is acceptable.
- O1 (Gemini transcript double-fire) preserved as current accumulation semantics → live-validation **B-08** (add to WBS at sprint close).
- S2-02 (post-hoc safety gate + REQ-9 honesty docs) is the remaining Sprint 2 story.
