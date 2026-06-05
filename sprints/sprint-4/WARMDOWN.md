# Sprint 4 — Warm-down (FINAL — program complete)

> **Author:** Opus 4.8 (1M) · 2026-06-05. **Outcome:** Goal achieved — streaming-by-default `0.4.0` is LIVE on npm (28 packages), tag `v0.4.0`. Program complete (Sprints 0–4 closed).

## 1. Goal recap
**Goal:** live smoke + docs/ADR-0004 + unified 0.4.0 bump + (user-authorized) real publish.
**Hit it?** **Yes.** Smoke runs (>1 delta), ADR-0004 + docs migrated, 28 packages bumped 0.3.20→0.4.0 and **published for real** to npm; tagged v0.4.0.

## 2. Stories shipped
| Story | Commit | Notes |
|-------|--------|-------|
| S4-01 | `28a6edb` | Deterministic streaming smoke example (4 text-delta) |
| S4-02 | `77cf7e8` | docs + ADR-0004 (lifecycle, mode table, REQ-9 advisory) |
| S4-03 | `b6c4f25` (tag v0.4.0) | 28 pkgs → 0.4.0 + CHANGELOG + REAL `pnpm publish -r` (verified live) |

## 3. What shipped (program-level)
Streaming-by-default across text (Sprint 1), native-realtime voice (Sprint 2), and cascaded TTFT (Sprint 3), on the breaking `text-start`/`text-delta{id,delta}`/`text-end`/`text-cancel` lifecycle, with `speakGated` as the shared gated emitter and the honest REQ-9 native-realtime advisory. Released as 0.4.0.

## 4. Known issues / follow-ups
| ID | Description | Severity | Tracking |
|----|-------------|----------|----------|
| B-06 | `typecheck:all` red on 4 pre-existing test/example tsconfigs — NOT shipped (tarballs build from src, clean). Fix before next release for a fully-green gate. | major (quality) | B-06 |
| B-07 | `Hook.onStreamPart`/`AgentStreamPart` possibly dead public surface — investigate/remove. | minor | B-07 |
| B-08 | Live-Gemini transcript double-fire validation (voice TokenSource). | minor | B-08 |
| KI-4-01 | Live cascaded TTS TTFT number unverified-without-credentials (deterministic adapter proof stands). | minor | credentialed follow-up |
| KI-4-02 | `main` not yet merged — `plan/streaming-by-default` holds 0.4.0; merge PR/fast-forward pending (human step). | — | post-release |

## 5. Decisions
- **User override:** published a real incremental **0.4.0 minor** (not the kickoff's dry-run ceiling). Confirmed via AskUserQuestion (0.4.0 minor + real publish). Breaking-as-patch was rejected (would silently break ^0.3.20 consumers).
- B-06: shipped code is clean; published with a documented non-shipping note rather than blocking the user-requested release.

## 6. Metrics
- Release: 28 packages @ 0.4.0 live on npm; tag v0.4.0; commit b6c4f25.
- Program: 5 sprints, ~20 commits on `plan/streaming-by-default`.

## 7. Retrospective
**Keep:** manager-driven publish (dry-run eyeball → real) with explicit pre-publish safety scan (no secrets/maps, versions-together, private-excluded). `/delegate-review` on Sprints 1 & 3 caught real latent defects.
**Change:** recurring cursor proof-JSON hygiene (malformed escapes / missing fields) — kept relying on independent manager re-verification; consider a stricter proof template or a proof-lint step.
**Try next:** clear B-06 (the 4 typecheck configs) so the next release ships a fully-green `typecheck:all`.

## 8. Closeout
- [x] S4-01/02/03 PROCEED; manager review Approve; 0.4.0 published + verified live; tag v0.4.0.
- [x] Program complete (Sprints 0–4). STATE updated.
- [ ] **Human follow-up:** merge `plan/streaming-by-default` → `main`.

Sprint 4 is closed. **Program complete.**
