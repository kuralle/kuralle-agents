# Proceed Evidence — `S3-02` cascaded TTFT e2e assertion + offline timeline artifact

> Manager artifact — Phase A.

## Story
- **Id:** `S3-02` · **Commit:** `9eb1e8d` · **IC slug:** `stream-s3-02` (cursor)

## Proceed checklist
- [x] `verify-handoff-proof.sh stream-s3-02` → `PROOF_OK` (3 claims, 4 assertions; incl. `file_exists` for the artifact).
- [x] **Offline artifact** `sprints/sprint-3/artifacts/s3-ttft.txt` shows the deterministic TTFT timeline: `aria_runtime_ttft` at the first delta `[3]`, before delta 2 `[4]`, before `aria_runtime_end` `[7]`; `ttftIndex 0 < endIndex 1`; `ttftMs ≤ durationMs`. Plus the §11 framing (ungated improves, gated buffers by design).
- [x] **Live e2e** gained `assertFirstAudioBeforeRuntimeEnd` (`ws-cascaded-e2e.ts:304-305`, "Ungated text turn: first TTS audio before runtime turn-end (REQ-10)"); skip-guarded (still SKIPs cleanly without LiveKit/OpenAI keys).
- [x] No §11 abort — TTFT improvement proven deterministically (offline) + asserted live (skip-guarded). No suppression (0). Scope clean (e2e + harness helpers + artifact). Full `test` green; guard no-new-failures.

**Verdict:** `PROCEED`

## One-line summary
Cascaded TTFT improvement proven: deterministic offline timeline (TTFT at first delta, before turn-end) + skip-guarded live e2e assertion; gated-vs-ungated framing honest · commit `9eb1e8d`.

## Notes
- Phase A of Sprint 3 complete (S3-01 + S3-02). Next: `/delegate-review` → manager review → closeout.

## Correction (post-`/delegate-review`, R-02)
The original wording over-claimed that "deterministic proof **plus** live assertion prove improvement." Corrected:
- **The TTFT improvement is proven by the DETERMINISTIC adapter test (S3-01)** — that is the verified §11 gate.
- The **live e2e** assertion was initially NOT turn-correlated (codex R-01: passed with unrelated audio + no `aria_runtime_ttft`). Fixed in **`[S3-fix]`** (`883eb3a`): `assertFirstAudioBeforeRuntimeEnd` now requires a turn-correlated `aria_runtime_ttft` before `aria_runtime_end`, with a negative test asserting it FAILS for unrelated-audio/no-ttft.
- The live e2e is **skip-guarded** (needs LiveKit + OpenAI keys) and was **SKIPPED locally** — so the *live* TTS proof is **unverified-without-credentials**. The deterministic adapter/offline proof stands on its own as the §11 gate.
