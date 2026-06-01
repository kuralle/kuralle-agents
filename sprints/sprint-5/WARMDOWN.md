# Sprint 5 — Warm-down

> **Author:** Opus 4.8 (1M) · 2026-06-01 (long-running program mode).
> **Outcome:** Goal achieved — broadcast idempotent across retry (ledger), reply enters a flow, drip stops on reply, re-engagement reopens the window.

## 1. Goal recap
**Sprint goal:** A broadcast template is idempotent across retry and a reply hands into a flow; a drip stops on reply; re-engagement reopens the window and resumes the flow.
**Did we hit it?** **Yes.** `BroadcastLedger.putIfAbsent` makes `(campaign,customer)` sends idempotent (proven ledger-based, not effect-log); broadcasts go through the pipeline to opted-in recipients only; a reply enters a flow via the normal router; drip `scheduleNext` respects `stoppedOnReply`; re-engagement template + reply reopens the window. Gate: `typecheck:all` green; **875 tests / 0 fail**.

## 2. Stories shipped
| Story | Status | Commit | Demo |
|-------|--------|--------|------|
| S5-01 | Done | `6b95939` | [s5-01-tests.txt](./artifacts/s5-01-tests.txt) |
| S5-02 | Done | `d0e3787` | [s5-02-tests.txt](./artifacts/s5-02-tests.txt) |
| S5-03 | Done | `8bdac7b` | [s5-03-tests.txt](./artifacts/s5-03-tests.txt) |
No slips; no fix-pass code change.

## 3. What's working
- **Scheduler** deterministic (counter id, injectable timer) — `scheduler_enqueue_fires`, `scheduler_cancel_prevents`.
- **Broadcast idempotent across retry** (ledger, not effect-log; fresh-ledger re-sends) — `broadcast_ledger_idempotent_per_campaign_recipient`; reply enters flow — `broadcast_reply_enters_flow`.
- **Drip stop-on-reply + re-engagement reopens window** — `drip_stops_on_reply`, `reengagement_reopens_window_and_resumes`.

## 4. Known issues
| ID | Description | Severity |
|----|-------------|----------|
| KI-5-01 | In-memory `BroadcastLedger` + in-process `Scheduler` only; durable/production adapters documented, not implemented (multi-process needs durable ledger). | minor (intended/backlog) |
| KI-5-02 | Re-engagement "resume" tested at the seam (template send + window reopen), not a full live runtime resume. | minor (intended) |

No blockers/majors.

## 5. Decisions made
- **Decision:** Broadcast idempotency via explicit `BroadcastLedger.putIfAbsent`, never the per-run effect log (`runId==sessionId`). **Source:** PLAN §0 / R-07. **RFC amendment:** none.
- **Decision:** Scheduler uses a counter jobId + injectable timer (deterministic tests). **Source:** PLAN §0. **RFC amendment:** none.
- **Decision:** `SendJob`/`Campaign`/`DripStep` concrete shapes (RFC gap-fill). **Source:** briefs. **RFC amendment:** none.

## 6. RFC amendments
None. Surfaces match RFC §4.7.

## 7. Metrics
- **Test count:** 875 (added: 11). **`typecheck:all`:** green. **Diff:** 3 commits, +936 across 11 files.

## 8. Backlog updates
None new (durable ledger/scheduler adapters already implied by RFC; not yet a tracked BK item — note for Sprint 7 release docs).

## 9. Retrospective
### Keep
Making idempotency a behavioral two-run-plus-fresh-ledger test (Sprint-4 Try-next) nailed R-07 — the fresh-ledger re-send is exactly the assertion that distinguishes ledger-based from effect-log-based dedup. Deterministic scheduler design avoided timer flakiness.
### Change
Nothing material — three clean stories.
### Try next
Sprint 6 has a **hard verification gate (S6-02 / Q7):** re-verify Instagram specifics (24h window, `HUMAN_AGENT` tag duration, quick-reply ≤13 / carousel caps) against **current Meta docs** before building the IG policy (G2). Do the web-research verification first; if Meta diverges from the RFC assumption, **flag via `/grill-me`** (a real flag-point) rather than silently coding to a stale assumption. Also: S6 is the first sprint to wire the `ChannelPolicy` into the `windowGuard`/renderer/inbound (the rev3 unification) — confirm it doesn't regress the WhatsApp path (`whatsapp_policy_unchanged_behavior`).

## 10. Pointers for the next sprint (Sprint 6 — Channel adapters)
- **Files to read first:** `packages/kuralle-engagement/src/policy.ts` (`ChannelPolicy`/`ClosedWindowStrategy` from S0-04 — G1/G2 implement real policies), `packages/kuralle-messaging-meta/src/whatsapp/{client,policy?}.ts` (WhatsApp policy: window via WindowStore, `closedWindow:{kind:'template',strategist}`, renderer, inbound), `packages/kuralle-messaging-meta/src/instagram/client.ts` (IG: `sendTextWithTag` ~423-438 text-only tag, `sendButtonTemplate` ~186, `sendQuickReplies` ≤13 ~299, `sendGenericTemplate` ~323), the `windowGuard`/`interactiveRenderer`/inbound-resolver (Sprint 6 makes them read the injected `policy`).
- **Traps:** **S6-02 is a HARD GATE before G2** — verify IG specifics vs current Meta Instagram Platform docs; `/grill-me` if divergent. IG closed-window `message-tag` wraps **text only** — interactive/media defer (IG-CW, rev4). The `ChannelPolicy` unification of the guard/renderer/inbound must NOT regress the WhatsApp path (test `whatsapp_policy_unchanged_behavior`). `webPolicy` (S0-04) already exists.
- **Seams to build on:** S0-04 `ChannelPolicy`/`webPolicy`, S1 windowGuard/pipeline, S2 strategist (WhatsApp `closedWindow`), S3 renderer/inbound resolver (per-policy), S4 consent/ownership.
- **Open RFC amendments:** none. **Open blockers:** none (S6-02 may surface one — handle at that gate).

## 11. Closeout
- [x] Stories committed (S5-01..03). [x] No `Apply now`. [x] HANDOFF (local). [x] STATE → Sprint 6. [x] Artifacts archived.
Sprint 5 is closed.
