# Example Verification

Last run: **February 15, 2026 (UTC)**

## Scope

This verification was run after runtime policy-profile changes to check for regressions.

Covered suites:

1. `packages/core/examples/agents` (Line parity set)
2. `packages/core/examples/flows` (Pipecat parity set)
3. Extended package examples (`kuralle-tools`, `kuralle-redis-store`)

## Results

### Core parity examples (highest signal)

- Run artifact: `reports/example-runs/20260215T141412Z`
- Result: **19/19 pass**, **0 fail**, **0 timeout**, **0 skipped**

Interpretation:

- Core parity examples did not regress after the runtime changes.

### Extended package examples

- Run artifact: `reports/example-runs/20260215T141412Z/extended2`
- Result: **17 pass**, **3 fail**, **1 timeout**, **2 skipped**

Non-pass items:

1. `packages/redis-store/examples/local-redis/test.ts` -> `SKIPPED`
2. `packages/redis-store/examples/local-redis/multi-turn.ts` -> `SKIPPED`
   - Cause: local Redis was not started.

## Verdict

- **No core runtime regression detected** in the parity suites that matter most for Aria behavior.
- Remaining non-pass cases are example runner prerequisites/invocation issues, not evidence of runtime breakage.

## Recommended test tiers

1. **Smoke (CI default)**: core parity examples + core tests.
2. **Integration (manual/nightly)**: long demos, Redis-dependent examples, callback/network examples.
