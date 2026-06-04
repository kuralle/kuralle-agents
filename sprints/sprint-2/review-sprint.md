# Review (r1, sandwich) — Sprint 2 "Voice (native realtime)"

> **Reviewer (main session):** Opus 4.8 (1M) · 2026-06-05.
> **Diff under review:** `71d80c8` (S2-01), `54464b0` (S2-02) on `plan/streaming-by-default`.
> **Adversarial pass:** `/delegate-review` is optional for Sprint 2 (recommended for Sprint 3's TTFT). Manager verified REQ-9 honesty + barge-in directly.

## 1. Strengths
- **REQ-9 implemented honestly** — `gateScope:'advisory'` (`channel.ts:34`), `safety-blocked` emitted, correction **requested** not "prevented" (`posthoc-gate.test.ts:66-68`); README states the advisory constraint + the cascaded contrast (`README.md:28`); honesty grep finds no "blocked before emission" claim. This is the sprint's whole point and it's correct.
- **Barge-in preserved through the refactor** — the interrupt path keeps its own `truncateToHeard(draftText, heardCharCount)` emit (`VoiceDriver.ts:119`) and does NOT route through `speakGated`; existing voice/conformance suite stayed green (12/0).
- **Clean push-to-pull adapter** — `deferredTokenSource.ts` bridges the event-driven `onTranscript` into the `TokenSource` `speakGated` expects, with `close()` on every terminal path (turn-complete/interrupt/abort/error) — no hang risk; covered by its own test.
- **Graceful provider degradation** — `client.requestResponse?.(...)` (`VoiceDriver.ts:57`) + a test asserting no-throw when the client lacks the method (O3 handled).

## 2. Critique
### Blockers / Majors
None. REQ-9 verified; barge-in regression-free; full suite green; no suppression.

### Minors / Nits
- **m1 (public surface):** `safety-blocked`/`pipeline-validation-block` added to `HarnessStreamPart` (`stream.ts`) — additive and necessary (so `ctx.emit` can carry them), but it's a public-union growth. Add a one-line RFC §4.2 note at the Sprint-4 docs pass. Not blocking (guard: no new typecheck failures).
- **m2 (latent, S2-01 notes):** interrupted turns surface streamed deltas + a fresh-id `truncateToHeard` trio (double-surface). Honest for native realtime (audio already spoken) and different ids ⇒ no REQ-7 breach; acceptable.

## 3. Cross-cutting
- **REQ-12:** extraction (`waitForUserTurn`) untouched, emits zero text lifecycle events (asserted).
- **Hard invariant (correct scoping):** the "never emit blocked content" invariant is NOT claimed for native realtime audio (REQ-9) — it remains preventive only on text/cascaded. The code/docs are honest about this.
- **No suppression** across both commits; tests use the fake realtime client (offline).
- **Backlog:** B-08 (live-Gemini transcript double-fire validation) tracked.

## 4. Constructive close
Sprint 2 routed voice onto the shared `speakGated` path without breaking the delicate barge-in/truncate machinery, and — most importantly — told the truth about native realtime: the gate is advisory, not preventive. Sprint 3 (cascaded TTFT) is where the streaming pays off measurably; run `/delegate-review` there and honor the §11 abort if TTFT doesn't improve.

## 5. Verdict
- [x] **Approve.** No blockers/majors; m1/m2 are documented minors carried forward (RFC note at Sprint 4). REQ-9 honesty + barge-in + full-suite-green all manager-verified.

**Path forward:** close Sprint 2 (WARMDOWN + HANDOFF + STATE → Sprint 3).
