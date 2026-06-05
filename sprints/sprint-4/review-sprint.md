# Review (r1) — Sprint 4 "Polish + 0.4.0 + REAL publish"

> Reviewer: Opus 4.8 (1M) · 2026-06-05. Diff: S4-01 `28a6edb`, S4-02 `77cf7e8`, S4-03 `b6c4f25` (tag v0.4.0).

## Strengths
- **Live streaming smoke is real** — `examples/streaming-smoke.ts` runs with a deterministic mock model (no key) and emits 4 `text-delta`s; manager ran it (`grep -c` → 4 > 1).
- **Docs/ADR complete** — ADR-0004 records the decision, mode table, breaking lifecycle, REQ-9 advisory; all public docs migrated `part.text → part.delta` (grep-clean).
- **Release executed safely** — manager-driven (not delegated): dry-run eyeballed (no secrets/maps in tarballs, all 28 @0.4.0, private excluded), then real publish; verified live on npm; tagged.

## Critique
- **Blockers/Majors:** none.
- **m1 (B-06, known/non-shipping):** `typecheck:all` still red on 4 pre-existing test/example tsconfigs — NOT in published tarballs (built from `src`, which is clean). Documented in CHANGELOG + tracked as follow-up. Acceptable for this release per shipped-code-is-clean; should be fixed before the next release for a fully-green gate.
- **Proof hygiene:** S4-02 proof had an invalid-JSON escape (manager-repaired); substance independently verified.

## Cross-cutting
- No suppression across S4-01/02/03. Build clean; full `test` green (prior sprints); guard no-new-failures. Internal deps `workspace:*` → graph versioned together (no two-copies-of-core failure).

## Verdict
- [x] **Approve — released.** 0.4.0 live on npm (28 packages), tag v0.4.0. m1 (B-06) is a documented non-shipping follow-up.

**Path forward:** program complete. Remaining human step: merge `plan/streaming-by-default` → `main` (PR or fast-forward) so main reflects the released 0.4.0.
