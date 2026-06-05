# Proceed Evidence — `S3-01` deterministic cascaded TTFT-on-first-delta test

> Manager artifact — Phase A. The RFC §11 abort gate.

## Story
- **Id:** `S3-01` · **Commit:** `f0bc058` · **IC slug:** `stream-s3-01` (cursor)

## Proceed checklist (manager — §11 gate verified directly)
- [x] `verify-handoff-proof.sh stream-s3-01` → `PROOF_OK` (3 claims, 4 assertions) **after manager re-recorded the `adapter-test` + `test` sidecars/shas** (the recorded shas mismatched because the outputs carry non-deterministic timing — `ttftMs`/`durationMs`/WS timestamps; substance independently re-run).
- [x] **§11 gate honest + passing — TTFT IS first-token, not whole-turn:** the test (`aria_runtime_llm_adapter.test.ts:232-278`) makes the fake runtime **await the `aria_runtime_ttft` metric before yielding delta 2** (`:234-251`), then asserts `ttftRecordedBeforeSecondDelta` (`:263`), exactly one ttft metric (`:267`), `ttftIndex < endIndex` (`:273`), and `ttftMs ≤ durationMs` (`:278`). **No §11 abort — TTFT improves.**
- [x] **Test-only scope** — no adapter src change (confirms S1-fix's `recordTtftOnce`-on-first-delta was already correct). Manager ran the adapter test: 8/0 pass; full `bun run test`: green.
- [x] Cancel-halt case still green (`:194-198`). No suppression (0).

**Verdict:** `PROCEED`

## One-line summary
Deterministic proof that the cascaded adapter records `aria_runtime_ttft` at the FIRST delta (before delta 2 + before turn-end) — TTFT = first-token, §11 abort does not fire · commit `f0bc058`.

## Notes
- Proof-hygiene: sha-of-non-deterministic-test-output is inherently unstable; manager re-recorded sidecars from a fresh run to make the proof self-consistent. The real gate is the independent re-run + the ordering assertions, both verified.
- §11 framing holds: this proves improvement for a *streaming* (multi-delta) reply. A `turn`-mode gated node buffers by design (no improvement expected) — S3-02 documents that contrast.
