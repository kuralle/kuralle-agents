# Proceed Evidence — `S7-01` F1: engagement() wiring

> **Manager artifact — Phase A only.**

## Story
- **Id:** `S7-01` · **Commit:** `fe6bb31` · **Slug:** `s7-01` · **Worker:** cursor.

## Proceed checklist (manager — read diff, did not trust IC chat)
- [x] **Diff read** — `engagement/src/engagement.ts` (`engagement()` + `policyInboundResolver` + `createBroadcastApi` guard), index, test. Scope matches brief.
- [x] **Terminal-guard invariant preserved** — `windowGuard` is NOT referenced in `engagement.ts` (`grep` clean); `bridge.outbound = [consentGate?, ownershipGate?, closedWindowRecovery, interactiveRenderer]`; the router appends `windowGuard` terminal. `engagement_composes_bridge` asserts a router builds without throwing.
- [x] **Bridge shape** — `Pick<MessagingRouterConfig,...>` with `outbound`/`inputResolver`/`windowStore`/`ownership`/`consent`; gates present only when the store is provided. `policyInboundResolver` dispatches by `m.platform`.
- [x] **`.broadcasts` guarded** — `createBroadcastApi({broadcastPipeline, ...})`; a missing pipeline yields a clear error path (not a silent no-op) — documented.
- [x] **`verify-handoff-proof.sh s7-01` → `PROOF_OK`** (3 claims, 4 assertions) — first-try clean.
- [x] **Independent verification:** `bun run build` exit 0; engagement test **5 pass / 0 fail** (both named present); `typecheck:all` green.
- [x] No `--no-verify`/suppression. Demo artifact committed. No stray notes.

**Verdict:** `PROCEED`

## One-line summary
`engagement({policies})` → `{bridge, broadcasts}` composes the channel-agnostic chain (gates + closedWindowRecovery + interactiveRenderer; windowGuard appended by the router) + policy inbound resolver + stores · 5 tests green · proof `s7-01` · commit `fe6bb31`.

## Notes
- `.broadcasts` wiring concretized via `opts.broadcastPipeline` (caller-supplied) — the §4.5 underspecification resolved without an interface change (no policy-client exposure needed). The F2 example wires the WhatsApp broadcast pipeline.
