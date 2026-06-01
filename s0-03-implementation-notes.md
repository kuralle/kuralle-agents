# S0-03 implementation notes

## Decisions

- **Merge site:** `openRun` only — `formData` shallow-merged into `runState.state` with `putRunState` before the input-queueing block; no `runFlow` / effect plumbing (per brief).
- **Effective input:** `selection.id ?? input`; guard and queued content use `effectiveInput`. When `selection` is absent, behavior is unchanged.
- **Replay idempotency:** Re-applying the same `formData` keys overwrites with identical values (shallow merge), so resumed opens do not accumulate duplicate structure.

## activeFlow vs no-activeFlow

`selection_id_is_routing_input` covers both paths in one test: without `activeFlow`, a user message is appended to `runState.messages` and session; with `activeFlow`, messages stay empty and `peekPendingUserInput` is `'RESUME'`.

## Export path

`ResolvedSelection` is exported from `@kuralle-agents/core` via `export type * from './types/index.js'` (includes new `selection.js`).
