# Proceed Evidence — `S4-01` streaming smoke example

> Manager artifact — Phase A.

## Story
- **Id:** `S4-01` · **Commit:** `28a6edb` · **IC:** cursor (`stream-s4-01`)

## Checklist
- [x] `verify-handoff-proof.sh stream-s4-01` → PROOF_OK (2 claims, 3 assertions).
- [x] **Manager ran the smoke directly:** `bun run packages/kuralle-core/examples/streaming-smoke.ts | grep -c '"type":"text-delta"'` → **4** (>1) ✓. Deterministic mock model (no API key) → ungated reply → multiple deltas.
- [x] No suppression; scope = example + artifact only.

**Verdict:** `PROCEED`

## One-line
Runnable deterministic streaming smoke prints text-start → 4 text-delta → text-end → turn-end (>1 delta proven) · `28a6edb`.
