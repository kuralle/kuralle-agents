# Sprint 2 — Plan

**Sprint name:** Voice (native realtime)
**Sprint goal (one sentence):** Route `VoiceDriver` through `speakGated` via a transcript-backed `TokenSource` so the native realtime assistant transcript streams incrementally, with the whole-answer gate running honestly post-hoc (REQ-9) and barge-in/truncate preserved.
**Sprint window:** 2026-06-05 (continued session / next session)
**Author (main session):** Opus 4.8 (1M) · 2026-06-05

**Load-bearing input:** `.understanding/voicedriver-streaming.md` (committed `5edc061`) — the transcript/barge-in/gate map. Read it before briefing either story.

---

## 0. Open-question resolutions (manager decisions — bind the briefs)

- **O1 — Transcript double-fire (Gemini parts + cumulative outputTranscription):** the `TokenSource` pushes **exactly what `onTranscript('assistant')` delivers today** — same accumulation semantics the current `draftText += text` uses (`VoiceDriver.ts:184`). Do NOT add new dedup logic; today's behavior is the baseline. Streaming makes any latent double-count *visible* (overlapping deltas) where it was hidden in one blob — so flag a **live-Gemini validation** item (does `outputTranscription` overlap `modelTurn.parts[].text`?) as **B-08**, not a Sprint-2 blocker. Offline fake-client tests use **non-overlapping** chunks (the realistic streaming case).
- **O2 — Safety-event placement:** `speakGated` stays provider-agnostic (emits only the text lifecycle). `VoiceDriver` emits the post-hoc `safety-*`/`pipeline-validation-*` events and triggers the provider interrupt + correction **after** `speakGated` returns (voice-specific).
- **O3 — Correction mechanism:** use the `RealtimeAudioClient`'s existing speak/response method (`requestResponse` or `sendClientContent` — IC confirms from the client interface). The **offline fake-client test asserts the correction is REQUESTED** (a `safety-*` event + a correction call), NOT that audio was prevented (REQ-9 — advisory).

---

## 1. Stories

### `S2-01` — Transcript `TokenSource` (C7a)
**Description:** Adapt the `onTranscript('assistant')` stream into a `TokenSource` feeding `speakGated`, replacing the accumulate-then-single-emit block in `VoiceDriver.runAgentTurn` (the normal-path emit ~`VoiceDriver.ts:99-113`). Use a **push-to-pull adapter** (`createDeferredTokenSource()` → `{source, push, close}`): wire `onTranscript('assistant')`→`push(text)`, `onTurnComplete`/`onInterrupted`/`onAbort`/`onError`→`close()`. Feed `source` to `speakGated` with `mode = resolveStreamMode(ctx, node)` and `runGate = applyPostTurnPolicies`-adapter (same `GateOutcome` adaptation as `TextDriver`). **Preserve** `heardCharCount`/`truncateAt`/`truncateToHeard`/barge-in and the interrupt-truncate emit path. `waitForUserTurn` (extraction, `VoiceDriver.ts:268-305`) stays untouched (REQ-12).

**Acceptance criteria:**
1. Native-realtime assistant text now streams incrementally: in the fake-realtime-client test, a multi-chunk turn yields **>1** `text-delta` (was 1 single-shot trio).
2. **Barge-in regression-free:** truncate-on-interrupt still yields the heard prefix (`truncateToHeard(draftText, heardCharCount)`); existing voice interrupt/barge-in tests stay green.
3. `waitForUserTurn`/extraction emits ZERO text lifecycle events (REQ-12).
4. `typecheck:all` no-new-failures (guard); full `test` + voice suite green.

**Files:** `VoiceDriver.ts`; a small `createDeferredTokenSource` helper (in `streaming/` or inline); voice tests (fake-client).

### `S2-02` — Honest post-hoc gate (C7b, REQ-9)
**Description:** On the native realtime path, a `turn`-granularity gate runs **after** the provider has spoken: emit the relevant `safety-*`/`pipeline-validation-*` events and, on block, trigger the provider interrupt + correction utterance — but **never** claim emission was prevented. Document the constraint in the voice README + the driver.

**Acceptance criteria:**
1. Fake-client test: a blocking gate on native realtime emits the `safety-*` event + triggers a correction (asserts the correction is requested), and records the gate result as **advisory** (not "blocked-before-emit").
2. Voice README states: whole-answer content gates are **advisory** on native realtime audio; input-side gating + tool authority are the reliable controls (REQ-9). No code path or doc claims native audio was "blocked before emission".
3. `typecheck:all` no-new-failures; voice suite green; barge-in still green.

**Files:** `VoiceDriver.ts`; voice README (`packages/kuralle-realtime-audio/README.md` or the voice docs); voice tests.

---

## 2. Universal DoD (per story)
Same as Sprint 1 §2: no-new-typecheck, full test green, ≥1 happy + ≥1 failure test, proof JSON → PROCEED, no suppression/compat shim, brief-scope only (no repo-root/scratch files), grep migrations across `*.ts`+`*.js`+`*.mjs`.

## 3. Test plan
| Story | Layer | Type | Key assertion |
|-------|-------|------|---------------|
| S2-01 | unit (fake realtime client) | streaming | >1 `text-delta` for multi-chunk turn; barge-in truncates to heard prefix; extraction silent |
| S2-02 | unit (fake client) | post-hoc gate | block ⇒ `safety-*` + correction requested, recorded advisory; README states advisory |

**Hard invariant note:** unlike text/cascaded, "never emit blocked content" CANNOT hold for native realtime audio — do NOT assert it does; assert the gate is advisory (REQ-9).

## 4. Demo plan
Fake-realtime-client transcript showing incremental `text-delta` during a turn, a barge-in mid-turn yielding the truncated heard prefix, and a post-hoc gate firing a `safety-*` event + correction. Artifact under `sprints/sprint-2/artifacts/`.

## 5. Risks
| Risk | Detection | Mitigation |
|------|-----------|------------|
| Over-claiming the safety invariant on native realtime (honesty trap) | review: no code/doc says native audio "blocked before emission" | REQ-9 wording in tests + README; gate is advisory |
| Barge-in/`truncateToHeard` regression | existing voice interrupt tests must stay green | preserve `heardCharCount`/`truncateAt` semantics; only emission path changes |
| Transcript double-fire surfaced as duplicate deltas (Gemini, O1) | fake-client test uses non-overlapping chunks; live check = B-08 | preserve current accumulation semantics; flag live validation, not a blocker |
| Push-to-pull adapter deadlock (source never closes) | test hangs/timeout | `close()` on every terminal handler (turn-complete/interrupted/abort/error) |

## 6. Open questions
- O1–O3 resolved in §0. **B-08** (live-Gemini transcript-overlap validation) to add to WBS when S2-01 ships. `/delegate-review` optional this sprint (Sprint 3 TTFT is the next recommended one).
