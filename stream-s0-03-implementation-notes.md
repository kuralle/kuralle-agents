# stream-s0-03 implementation notes

## Decisions
- `nodeHasWholeAnswerGroundingGate` keys on `ReplyNode.confidenceGate` only, per `.understanding/stream-mode-grounding.md`. `node.grounding` is retrieval scope and does not force `turn`.
- Module-local helper (not exported); exercised via `resolveStreamMode` tests.
- Test ctx built with `createRunContext` + `core-durable/helpers` for type-safe `RunContext` without `as any`.

## Tradeoffs
- Third contributor (`confidenceGate`) is largely subsumed by `validationPolicies` in today's code but kept for RFC faithfulness and forward-safety (per sprint plan open question resolution).

## Verification
- `npm run build` (kuralle-core): exit 0
- `mode.test.ts`: 10/10 pass
- `guard-stream-s0-03.sh`: exit 0 (no new typecheck:all failures)

## Guard flake note
One intermediate `typecheck:all` run surfaced `cf-voice-realtime-gemini-flow` as a transient FAIL config; immediate re-run returned baseline-only failures. Artifact regenerated from a passing run.
