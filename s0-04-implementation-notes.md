# S0-04 implementation notes

## Scope delivered
- **A0.3 (`messaging`):** `WindowStore` / `WindowState` / `InMemoryWindowStore` wrapping `WindowTracker`; miss → `{ open: false, expiresAt: null }`.
- **A0.4 (`engagement`):** `ChannelPolicy`, `ClosedWindowStrategy`, `ChoiceOption`, forward-declared `SmartSendStrategist` (`TODO(S2-01)`), `webPolicy()` null adapter.
- No router or pipeline wiring (Sprint 1).

## Trade-offs / forward traps
1. **`ChoiceOption` in engagement** — Sprint 3 may need `{ type: 'interactive'; options: ChoiceOption[] }` on core `stream.ts`; core cannot import engagement, so `ChoiceOption` may relocate to core then. Left in engagement per brief.
2. **`SmartSendStrategist` placeholder** — `decide(input: unknown): Promise<unknown>` until S2-01; grep `TODO(S2-01)`.

## Root causes / dependencies
- `engagement` imports `@kuralle-agents/messaging` + `ResolvedSelection` from `@kuralle-agents/core` (via `export type * from './types/index.js'` from S0-03).
- Rebuilt messaging before engagement; `bun install` after adding messaging dep.

## Verification
- `window_store_fail_closed`, `web_null_policy_always_open`, `bun run typecheck:all` — proof `.handoff/proof-s0-04.json`.
