# Review (r1, sandwich) — Sprint 3 "Cascaded TTFT"

> **Reviewer (main session):** Opus 4.8 (1M) · 2026-06-05.
> **Diff:** `663c673..HEAD` — S3-01 `f0bc058`, S3-02 `9eb1e8d`, S3-fix `883eb3a` (adapter code pre-landed in `[S1-fix]` `0a65cad`).
> **Adversarial pass:** `/delegate-review` → codex (gpt-5.5, high), **not-ready** with 2 findings (R-01, R-02); R-01 fixed in `[S3-fix]`, R-02 corrected in `proceed-s3-02.md`.

## 1. Strengths
- **The §11 abort gate is honest and passes** — the deterministic adapter test (`aria_runtime_llm_adapter.test.ts:232-278`) makes the fake runtime await `aria_runtime_ttft` before yielding delta 2, then asserts `ttftRecordedBeforeSecondDelta`, `ttftIndex < endIndex`, `ttftMs ≤ durationMs`. TTFT genuinely records at first-token, not whole-turn. **No abort.**
- **Adapter code was already correct** (S1-fix): `.delta` consumed, lifecycle ignored, cancel-halt, `recordTtftOnce` on first delta — Sprint 3 proved it rather than re-writing it (minimal, surgical).
- **Honest framing** — the artifact + docs are explicit that improvement is for ungated (token/sentence) replies; a `turn`-mode gated node buffers by design (REQ-3). No over-claim of "always faster."
- **The fix tightened a real weakness** — `[S3-fix]` made `assertFirstAudioBeforeRuntimeEnd` turn-correlated + TTFT-required, with a negative test (`harness-assertions.test.ts:83`) asserting it FAILS for unrelated-audio/no-ttft (the exact hole codex found).

## 2. Critique (codex findings — resolved)
### Majors
- **M1 (R-01) — live e2e assertion not turn-correlated.** `assertFirstAudioBeforeRuntimeEnd` passed with unrelated binary audio and no `aria_runtime_ttft`. **Fixed** `[S3-fix]` `883eb3a`: requires turn-windowed `aria_runtime_ttft` before `aria_runtime_end` + correlated audio; negative test guards it. Verified.
### Minors
- **m1 (R-02) — proceed over-claim.** `proceed-s3-02.md` said the live assertion proved improvement; the live e2e is skip-guarded and was SKIPPED (no keys). **Corrected** in `proceed-s3-02.md` (the deterministic adapter test is the verified gate; live proof is unverified-without-credentials).

## 3. Cross-cutting
- **No residual buffering for ungated replies** — codex traced TextDriver(token)→speakGated→ctx.emit→adapter queue; first delta reaches the queue immediately; `recordTtftOnce` fires there. (codex did not refute the core claim.)
- **No suppression** across S3-01/02/fix. Full `test` green; guard no-new-failures; harness-assertions 3/0.
- **Pre-publish posture:** the §11 gate is deterministic and CI-able; the live TTS proof requires credentials (honestly marked unverified-locally). Acceptable to publish — the latency mechanism is proven; the live number is a credentialed follow-up.

## 4. Constructive close
Sprint 3 was proof-dominant (the code shipped in S1-fix), and the adversarial pass paid off by catching a non-correlated live assertion that would have been a false proof. The §11 gate is honest and green. Proceed to Sprint 4 (docs/ADR-0004 + unified `0.4.0` bump + **real publish** per the user's explicit authorization).

## 5. Verdict
- [x] **Approve — fixes applied.** M1 fixed (`[S3-fix]`), m1 corrected. §11 abort does not fire (TTFT improvement proven deterministically). No remaining blockers/majors.

**Path forward:** close Sprint 3 → Sprint 4 (docs + ADR + 0.4.0 + real `pnpm publish -r`).
