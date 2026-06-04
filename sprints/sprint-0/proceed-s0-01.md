# Proceed Evidence — `S0-01` streamGranularity field on gate interfaces

> Manager artifact — Phase A. Confirms this story may proceed to the next.

## Story
- **Id:** `S0-01`
- **Commit:** `19f3505` — `[S0-01] streamGranularity field on gate interfaces`
- **IC slug:** `stream-s0-01` (`.handoff/brief-stream-s0-01.md`, worker: cursor)

## Proceed checklist (manager — read diff, not IC chat)
- [x] Diff read — scope matches brief §3 (2 src files +2 lines each, 1 test, guard script + output; nothing else touched)
- [x] `.handoff/proof-stream-s0-01.json` exists
- [x] `verify-handoff-proof.sh stream-s0-01` → `PROOF_OK` (3 claims verified, 4 assertions satisfied)
- [x] `assertions_satisfied` == `assertions_required` (REQ-5, test:stream_granularity_field, cmd:build_core, cmd:typecheck_no_new_failures)
- [x] Demo artifact present — `sprints/sprint-0/artifacts/s0-01-typecheck-guard.txt` (GUARD OK)
- [x] No `--no-verify` / type-suppression in diff (scanned: none)

**Verdict:** `PROCEED`

## One-line summary
`OutputProcessor` + `ValidationCapability` gained optional `streamGranularity?: 'sentence'|'turn'` (typedoc: absent ⇒ turn) · proof slug `stream-s0-01` · commit `19f3505`.

## Notes
- Convention matched: `readonly` on `ValidationCapability` field, plain optional on `OutputProcessor` (mirrors each file).
- Guard confirms `typecheck:all` still fails on exactly the 4 frozen baseline configs, core/test still 5 errors — **no new red**.
- Field is declared only; not read by any runtime path yet (S0-03 `resolveStreamMode` consumes it). Correct per brief.
