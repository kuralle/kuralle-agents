# Sprint 5 — Plan

**Sprint name:** Proactive outbound
**Sprint goal (one sentence):** A broadcast template is idempotent across retry and a reply hands into a flow; a drip stops on reply; re-engagement reopens the window and resumes the flow.
**Sprint window:** 2026-06-01 → 2026-06-08
**Author (main session):** Opus 4.8 (1M) · 2026-06-01

---

## 0. Decisions made before briefing (read first)

- **Everything lives in `@kuralle-agents/engagement`** (`src/{scheduler,broadcast,broadcast-ledger,drip}.ts`). No messaging/core changes — broadcasts send through an injected `OutboundPipeline` (from messaging) that the caller constructs.
- **R-07 — idempotency is an explicit `BroadcastLedger`, NEVER the per-run effect log.** `runId == sessionId` (`openRun.ts:31`), so the effect log dedupes WITHIN a conversation only — useless for `(campaign, customer)` dedup, and `RunOptions` has no `seed`. `BroadcastLedger.putIfAbsent(key)` is an **atomic** compare-and-set returning `false` if the key already exists. Broadcast loop: for each opted-in recipient, `if (!await ledger.putIfAbsent(`${campaign}:${customer}`)) continue;` then `pipeline.send(template)`. A duplicate run is a no-op. **Test it behaviorally** (second `putIfAbsent` of the same key returns false; a re-run sends zero new messages) and confirm it does not depend on the effect log.
- **Broadcasts send through the pipeline.** `pipeline.send({payload:{kind:'template', template}, ...})` — consent/ownership/window gates still apply (templates are window-agnostic so they pass the windowGuard). Only opted-in recipients (`consent.isOptedIn`) are sent.
- **A reply enters a flow via the normal inbound router path** — no special broadcast-reply code. The test asserts that an inbound from a broadcast recipient runs the flow (the existing router behavior).
- **Drip = per-step delay (Scheduler) + stop-on-reply.** Campaign state (`{ id, step, stoppedOnReply? }`) is **customer/conversation-keyed in the SessionStore** (workingMemory). On inbound, set `stoppedOnReply = true`; `drip.scheduleNext` early-returns when stopped. Re-engagement: a scheduled step sends an approved template that reopens the window (the customer's reply via the normal path reopens it / `windowStore.recordInbound`) and the resumed flow continues.
- **Scheduler:** `Scheduler { enqueue(job, {delayMs?}): Promise<string>; cancel(jobId): Promise<void> }`; default `InProcessScheduler` (timer-based). Documented production adapters (BullMQ / Cloud Tasks / cron) as a doc comment — not implemented. `SendJob`/`DripStep`/`Campaign` shapes are defined concretely (RFC under-specifies them) — note them.
- **Determinism in tests:** the in-process scheduler uses real timers; tests use very short delays (e.g. 5ms) or an injectable "now"/manual-tick. Avoid flakiness — prefer an injectable timer or `await` a tiny delay; do NOT use wall-clock-dependent assertions. (Note: `Date.now()` is fine in product code; tests should not depend on long real delays.)

---

## 1. Stories

### `S5-01` — E1: Scheduler interface + in-process impl
**Description:** `Scheduler` interface + `InProcessScheduler` (timer-based enqueue/cancel). Documented production adapters.
**Acceptance criteria:**
1. `Scheduler { enqueue(job: SendJob, opts?: { delayMs?: number }): Promise<string>; cancel(jobId: string): Promise<void> }`; `SendJob` shape defined (e.g. `{ kind: string; payload: unknown }` or a tagged union for broadcast/drip steps — concrete, documented).
2. `InProcessScheduler` runs the job after `delayMs` (default 0/immediate), returns a job id; `cancel(jobId)` prevents a not-yet-fired job from running.
3. Doc comment lists production adapters (BullMQ/Cloud Tasks/cron) — interface-compatible, not implemented.
4. Tests: `scheduler_enqueue_fires` (a job with a tiny delay runs; its effect observed), `scheduler_cancel_prevents` (cancelled job never runs). Use short delays or an injectable timer — no flaky wall-clock.
**Files:** `engagement/src/scheduler.ts`, `engagement/src/index.ts`; `engagement/test/scheduler.test.ts`.

### `S5-02` — E2: broadcast engine + BroadcastLedger (R-07)
**Description:** `BroadcastLedger` interface + `InMemoryBroadcastLedger` (atomic `putIfAbsent`). `createBroadcasts({ pipeline, consent, ledger, platform })` with `.send(campaign)`: opted-in recipients only, ledger-deduped, sends the approved template through the pipeline.
**Acceptance criteria:**
1. `BroadcastLedger { putIfAbsent(key: string): Promise<boolean> }` (`false` if key present); `InMemoryBroadcastLedger` atomic (a concurrent/repeat `putIfAbsent` of the same key returns false exactly once-true-then-false).
2. `createBroadcasts(...)` `.send(campaign)`: for each recipient where `consent.isOptedIn(customerId)`, `key = `${campaign.id}:${customerId}``; `if (!await ledger.putIfAbsent(key)) continue;` then `pipeline.send({threadId, platform, payload:{kind:'template', template: campaign.template}, meta})`. Un-opted-in recipients are skipped (no send).
3. `Campaign` shape defined (`{ id; template: OutboundTemplate; recipients: { customerId; threadId }[] }`), documented.
4. **Idempotent under retry:** calling `.send(campaign)` twice sends each recipient **once** total (the 2nd run's `putIfAbsent` returns false → skip). Behavioral test counts pipeline sends across two runs.
5. A reply enters a flow via the normal inbound router path (test: an inbound from a recipient runs the flow — reuse the router test harness; no special broadcast-reply code).
6. Tests: `broadcast_ledger_idempotent_per_campaign_recipient` (duplicate `(campaign,customer)` no-op across 2 runs; does NOT rely on the per-run effect log), `broadcast_reply_enters_flow`.
**Files:** `engagement/src/{broadcast,broadcast-ledger}.ts`, `engagement/src/index.ts`; `engagement/test/broadcast.test.ts`.

### `S5-03` — E3: drip/sequence + re-engagement
**Description:** Drip with per-step delay (via Scheduler) + stop-on-reply; re-engagement template reopens the window + resumes the flow.
**Acceptance criteria:**
1. `createDrip({ scheduler, pipeline, sessionStore/consent, platform })` (or similar) with a `scheduleNext(threadId, step)` that enqueues the next step after `step.delayMs` **only if** the campaign isn't `stoppedOnReply`.
2. Stop-on-reply: a helper (called from the inbound path / test) sets the campaign's `stoppedOnReply = true`; after that, `scheduleNext` early-returns (no enqueue).
3. Re-engagement: a scheduled step sends an approved template through the pipeline; the customer's reply (normal inbound) reopens the window (`windowStore.recordInbound`) and the resumed flow continues. (Test the seam: re-engagement send goes through the pipeline as a template; a subsequent inbound reopens the window — assert `windowStore.get` open after `recordInbound`.)
4. Tests: `drip_stops_on_reply` (after stop, `scheduleNext` enqueues nothing), `reengagement_reopens_window_and_resumes` (re-engagement template sent; inbound reopens window; flow resumes / next step proceeds).
**Files:** `engagement/src/drip.ts`, `engagement/src/index.ts`; `engagement/test/drip.test.ts`.

---

## 2. Universal DoD
Tests happy+failure offline & **deterministic** (no flaky wall-clock — short delays or injectable timer); `bun run build` + `typecheck:all` green; surfaces match RFC §4.7; **broadcast idempotency is a behavioral test independent of the effect log** (R-07); no `--no-verify`/suppression/silent-catch; atomic `[S5-{nn}]` commit + proof JSON; commit demo artifacts; no stray `*-implementation-notes.md`. Proof-schema cheat-sheet in every brief.

## 3. Test plan
| Story | Named tests |
|-------|-------------|
| S5-01 | `scheduler_enqueue_fires`, `scheduler_cancel_prevents` |
| S5-02 | `broadcast_ledger_idempotent_per_campaign_recipient`, `broadcast_reply_enters_flow` |
| S5-03 | `drip_stops_on_reply`, `reengagement_reopens_window_and_resumes` |

**Not tested (safe):** production scheduler adapters (documented, not implemented); live broadcast against Meta; multi-process ledger durability (in-memory default; durable backend backlog).

## 4. Demo plan
Offline: a broadcast run is a no-op on retry (ledger); a recipient reply enters the reorder flow; a drip halts when the customer replies; a re-engagement template reopens the window.

## 5. Risks
| Risk | Detection | Mitigation |
|------|-----------|------------|
| Broadcast idempotency relies on the per-run effect log (runId==sessionId) | duplicate sends across runs | explicit `BroadcastLedger.putIfAbsent`; behavioral test across 2 runs; assert no effect-log dependency. |
| Flaky timer-based scheduler tests | intermittent CI failures | short delays / injectable timer; no wall-clock assertions. |
| Broadcast bypasses consent/window | un-opted-in messaged / closed-window free-form leak | send through the pipeline (gates apply); opted-in filter before send. |
| Drip doesn't stop on reply | messages after customer replied | `stoppedOnReply` flag checked in `scheduleNext`; test. |

## 6. Open questions
None blocking. `SendJob`/`Campaign`/`DripStep` shapes are under-specified in the RFC — the IC defines concrete shapes and documents them (gap-fill, not divergence). If the in-process scheduler can't be made deterministic without an injectable timer, add one (constructor option) and note it.
