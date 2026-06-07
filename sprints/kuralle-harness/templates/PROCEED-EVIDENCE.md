# Proceed evidence — Sprint {N} (RFC-{NN})

**Decision:** PROCEED | HOLD
**Reviewed:** git diff `feat/kuralle-harness` (range: `<sha-before>..<sha-after>`)

## Gate results (manager ran these — not the IC's word)
| Check | Command | Result |
|-------|---------|--------|
| typecheck | `bun run typecheck:all` | |
| tests | `bun run test` | |
| fail-to-pass | RFC §9.1 `test:*` | |
| guard (S1 only) | `bash scripts/check-no-raw-tool-execute.sh` | |
| live smoke | RFC §9.3 demoable command | (observed: ) |

## Diff review (adversarial)
- Strengths (file:line):
- Blockers (file:line / repro):
- Brief fidelity / standard fidelity / debt fidelity / honesty:

## Verdict
PROCEED → advance STATE to Sprint {N+1}. | HOLD → re-delegate with named failure: <...>.
