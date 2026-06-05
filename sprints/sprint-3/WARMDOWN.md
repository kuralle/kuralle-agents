# Sprint 3 — Warm-down

> **Author:** Opus 4.8 (1M) · 2026-06-05. **Outcome:** Goal achieved — cascaded TTFT proven to drop to first-token latency for streaming replies; §11 abort does NOT fire. Full suite green; `typecheck:all` no-new-failures.

## 1. Goal recap
**Goal:** cascaded adapter consumes `.delta`, begins TTS before turn completes, `aria_runtime_ttft` drops to first-token.
**Hit it?** **Yes.** Adapter code already correct (S1-fix); Sprint 3 proved TTFT-at-first-delta deterministically (the §11 gate) + a turn-correlated live e2e assertion (skip-guarded). Honest framing: ungated improves, gated buffers by design.

## 2. Stories shipped
| Story | Commit | Notes |
|-------|--------|-------|
| S3-01 | `f0bc058` | Deterministic TTFT-on-first-delta unit test (the §11 gate); adapter code unchanged (already correct) |
| S3-02 | `9eb1e8d` | Live e2e first-chunk-before-turn-end assertion (skip-guarded) + offline timeline artifact |
| S3-fix | `883eb3a` | Phase B: turn-correlated TTFT assertion + negative test (codex R-01) |

## 3. What's working
- `aria_runtime_ttft` records at the FIRST `text-delta` (before delta 2, before `aria_runtime_end`) — proven deterministically.
- Cascaded adapter: `.delta` consumed, lifecycle ignored, `text-cancel` halts forwarding (S1-fix), TTFT first-token.
- Live e2e assertion is now turn-correlated (requires `aria_runtime_ttft` + correlated audio before turn-end); negative test guards the regression.

## 4. Known issues
| ID | Description | Severity | Tracking |
|----|-------------|----------|----------|
| KI-3-01 | `typecheck:all` RED on 4 pre-existing baseline configs. | major | B-06 (must fix before/with release) |
| KI-3-02 | Live TTS TTFT number unverified-without-credentials (e2e skip-guarded). Deterministic adapter proof stands as the gate. | minor | credentialed follow-up |

## 5. Decisions
- §11 framing: TTFT improvement is for ungated (token/sentence) replies; gated (turn-mode) buffers by design (REQ-3) — not an abort.
- The deterministic adapter test is the §11 gate; the live e2e is a credentialed bonus.

## 6. RFC amendments
None.

## 7. Metrics
- Commits: 4 (S3-01/02 + S3-fix + close). Adapter src unchanged (proof-dominant sprint).

## 8. Backlog updates
None new (B-06/B-07/B-08 stand).

## 9. Retrospective
**Keep:** `/delegate-review` caught a non-correlated live assertion (false-proof risk) — adversarial review on the latency claim was worth it. The deterministic await-gate test design makes the §11 claim airtight.
**Change:** I over-claimed the live proof in proceed-s3-02 (corrected post-review). Mark live-credentialed proofs as unverified-without-keys up front.
**Try next (Sprint 4):** the release. Decide B-06 (fix the 4 pre-existing test/example typecheck configs) — they don't ship (tarballs build from src, which is green) but the WBS flagged them as a release-quality gate. Version the WHOLE graph together (monorepo signature failure if piecemeal). User authorized **0.4.0 minor + real `pnpm publish -r`**.

## 10. Pointers for the next sprint (Sprint 4 — Polish + 0.4.0 + REAL publish)
- **User directive (this session):** publish a real, incremental **0.4.0 minor** bump (current 0.3.20) via real `pnpm publish -r` to npm. This **overrides** the kickoff's "dry-run ceiling / no autonomous publish."
- Read: `docs/rfc-streaming-by-default.md` §8 (C10/C11), REQ-9/11; `CLAUDE.md` Gotchas (version+publish together; pnpm rewrites workspace:* to exact versions; no .env/.map in tarballs; run npm/wrangler from neutral cwd).
- Tasks: S4-01 live streaming smoke example (run it, >1 delta); S4-02 docs + ADR-0004 (incl. native-realtime advisory + the `safety-blocked`/`AgentStreamPart` surface notes); S4-03 bump all 28 packages 0.3.20→0.4.0 (manual-version per 0.x+workspace:* gotcha), CHANGELOG breaking note (part.text→part.delta + lifecycle), then **real** `pnpm publish -r` (dry-run first, eyeball, then publish).
- **Pre-publish gate:** decide B-06 (fix or document-as-non-shipping); confirm `bun run build` green; private-leak scan; `pnpm publish -r --dry-run` clean BEFORE the real publish.

## 11. Closeout
- [x] S3-01 + S3-02 PROCEED; `/delegate-review` (codex not-ready, R-01/R-02) → `[S3-fix]` + proceed correction → manager review Approve.
- [x] WARMDOWN + HANDOFF written; STATE → Sprint 4.

Sprint 3 is closed.
