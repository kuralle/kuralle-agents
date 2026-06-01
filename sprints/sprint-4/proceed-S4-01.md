# Proceed Evidence — `S4-01` D1: OwnershipStore + inbound ownership gate

> **Manager artifact — Phase A only.**

## Story
- **Id:** `S4-01` · **Commit:** `fd46a5e` · **Slug:** `s4-01` · **Worker:** cursor.

## Proceed checklist (manager — read diff, did not trust IC chat)
- [x] **Diff read** — `messaging/src/adapter/ownership-store.ts` (interface), `createMessagingRouter.ts` (inbound gate + recordInboundToHistory + claim-on-handoff), `types/adapter.ts` (`ownership?`), `index.ts`; `engagement/src/ownership.ts` (`sessionOwnershipStore` + `ownershipGate`), `index.ts`; tests in both. Scope matches brief. No consent edits.
- [x] **REQ-21 satisfied (the critical check)** — the inbound gate `if (ownership.owner(threadId)==='human') { recordInboundToHistory(...); return; }` returns **before** `runtime.run`. The test `human_owned_inbound_does_not_run_flow` increments `runCount` inside the mock runtime's `run` and asserts `runCount === 0` while owned, `=== 1` after release — proves no flow side effects fire while human-owned, and resume on release. (Not merely "outbound count 0".)
- [x] **Deterministic claim** — after the turn, `if (ownership && parts.some(handoff→human)) ownership.claim(threadId,'human')` (consumes S0-05's emitted terminal-handoff part).
- [x] **`ownershipGate`** suppresses outbound while owned (`ownership_gate_suppresses`).
- [x] **`verify-handoff-proof.sh s4-01` → `PROOF_OK`** (4 claims, 6 assertions) — first-try clean.
- [x] **`assertions_satisfied == assertions_required`** (`REQ-10`, `REQ-21`, 3 named tests, `cmd:typecheck_all`).
- [x] **Independent verification:** `bun run build` exit 0; ownership-gate test 2 pass; all 3 named tests present (across messaging + engagement test files); `bun test packages/kuralle-messaging packages/kuralle-engagement` → **484 pass / 0 fail**; `typecheck:all` green.
- [x] No `--no-verify`/suppression. Demo artifact committed. No stray notes file.

**Verdict:** `PROCEED`

## One-line summary
`OwnershipStore` (messaging iface + SessionStore-backed engagement impl); inbound gate skips `runtime.run` while human-owned (REQ-21, behaviorally proven), `escalate→'human'` claims via the emitted handoff part, release resumes · 484 tests green · proof `s4-01` · commit `fd46a5e`.

## Notes
- Inbound recorded to history via `recordInboundToHistory` (uses the runtime's session store) — confirm in IC report whether `RuntimeLike` needed `getSessionStore?`; tests pass, so the path resolved.
