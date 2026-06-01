# Sprint 4 — Warm-down

> **Author:** Opus 4.8 (1M) · 2026-06-01 (long-running program mode).
> **Outcome:** Goal achieved — a human-owned conversation suppresses the bot on inbound (no `runtime.run`) and resumes on release; un-opted-in/STOP customers are never messaged.

## 1. Goal recap
**Sprint goal:** A human-owned conversation suppresses the bot on inbound and resumes on release; un-opted-in/STOP customers are never messaged.
**Did we hit it?** **Yes.** Inbound ownership gate skips `runtime.run` while human-owned (REQ-21, proven with a `runCount` assertion); `escalate→'human'` claims via the S0-05 handoff part; release resumes. Consent is customer-keyed, default opted-out; `consentGate` defers un-opted-in; STOP opts out. Gate: `typecheck:all` green; **864 tests / 0 fail**.

## 2. Stories shipped
| Story | Status | Commit | Demo |
|-------|--------|--------|------|
| S4-01 | Done | `fd46a5e` | [s4-01-tests.txt](./artifacts/s4-01-tests.txt) |
| S4-02 | Done | `cabc0f4` | [s4-02-tests.txt](./artifacts/s4-02-tests.txt) |
No slips; no fix-pass code change.

## 3. What's working
- **Inbound gate: `runtime.run` NOT called while human-owned** (`human_owned_inbound_does_not_run_flow`: runCount 0 owned → 1 after release).
- **escalate→claim** via emitted handoff part (`escalate_claims_ownership`); **ownershipGate** suppresses outbound (`ownership_gate_suppresses`).
- **Consent** customer-keyed, default opted-out; **consentGate** defers un-opted-in (`not_opted_in_blocks_send`); **STOP** opts out (`stop_opts_out_and_halts_drip`).

## 4. Known issues
| ID | Description | Severity |
|----|-------------|----------|
| KI-4-01 | `ownershipGate`/`consentGate` installed explicitly; auto-composition into `config.outbound` is the `engagement()` bridge — Sprint 7 (F1). | minor (intended) |
| KI-4-02 | "halts drip" currently = consent blocks the send; the drip stop-on-reply path is Sprint 5. | minor (intended) |

No blockers/majors.

## 5. Decisions made
- **Decision:** Inbound ownership gate is primary (before `runtime.run`); `ownershipGate` outbound is defense-in-depth. **Source:** PLAN §0 / REQ-21. **RFC amendment:** none.
- **Decision:** `OwnershipStore`/`ConsentStore` interfaces in `messaging` (router references them), impls+gates in `engagement`. **Source:** PLAN §0. **RFC amendment:** none.
- **Decision:** consent default **opted-out** (configurable). **Source:** PLAN §0 / REQ-11. **RFC amendment:** none.
- **Decision:** `escalate` claim from the emitted handoff part inspected after the turn (deterministic). **Source:** PLAN §0. **RFC amendment:** none.

## 6. RFC amendments
None. Surfaces match RFC §4.7/§4.11.

## 7. Metrics
- **Test count:** 864 (added: 11). **`typecheck:all`:** green. **Diff:** 2 commits, +669/−1 across 14 files.

## 8. Backlog updates
None (team-inbox UI BK-02 remains out of scope; the ownership *gate* shipped, the inbox *surface* did not — as planned).

## 9. Retrospective
### Keep
Making "`runtime.run` not called" a behavioral proof assertion (Sprint-3 Try-next) was exactly right for REQ-21 — the gate is the kind of thing a shape-only test would pass while leaking side effects. The IC even added a router-level `consent-stop.test.ts` beyond the brief.
### Change
Nothing material — two clean stories.
### Try next
Sprint 5 (proactive outbound) has the trickiest idempotency requirement (R-07: `BroadcastLedger` keyed by `(campaign, customer)`, NOT the per-run effect log since `runId==sessionId`). Add a brief assertion that a **duplicate broadcast send is a no-op across two ledger calls** (atomic `putIfAbsent` returns false the 2nd time) — make idempotency a behavioral test, and explicitly test it does NOT rely on the per-run effect log.

## 10. Pointers for the next sprint (Sprint 5 — Proactive outbound)
- **Files to read first:** `packages/kuralle-engagement/src/` (new `scheduler.ts`, `broadcast.ts`, `broadcast-ledger.ts`, `drip.ts`), the `OutboundPipeline` (broadcasts send templates **through the pipeline** — consent/ownership/window still apply), `packages/kuralle-engagement/src/consent.ts` (broadcasts only to opted-in), `packages/kuralle-core/src/runtime/openRun.ts` (`runId == sessionId` — line 31; why the per-run effect log can't dedupe broadcasts), the strategist/catalog (S2 — broadcasts use approved templates).
- **Traps (R-07):** broadcast idempotency MUST use an explicit `BroadcastLedger.putIfAbsent((campaign,customer))` (atomic), NOT the per-run effect log (which dedupes within a conversation only, since `runId==sessionId`, and `RunOptions` has no `seed`). A reply enters a flow via the normal inbound router path. Drips: per-step delay + stop-on-reply (set `session.campaign.stoppedOnReply` on inbound); re-engagement template reopens the window + resumes. Scheduler: in-process default + documented production adapters (BullMQ/Cloud Tasks/cron).
- **Seams to build on:** S1 pipeline (broadcast sends traverse it), S2 strategist/catalog (approved templates), S4 consent (opted-in filter), S0-03 selection (reply→flow), WindowStore (re-engagement reopens window).
- **Open RFC amendments:** none. **Open blockers:** none.

## 11. Closeout
- [x] Stories committed (S4-01..02). [x] No `Apply now`. [x] HANDOFF (local). [x] STATE → Sprint 5. [x] Artifacts archived.
Sprint 4 is closed.
