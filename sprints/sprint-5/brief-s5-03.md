# Story Brief — `S5-03` E3: drip/sequence + re-engagement

> **IC engineer (`cursor`, fresh process).** Self-contained. Ambiguity → **stop and ask**.
> **Atomic-commit:** `[S5-03] E3 drip + re-engagement` on **`plan/whatsapp-engagement`**. No push/`main`, one commit. **Bun.**

## 1. Goal
A drip/sequence with per-step delay (via the Scheduler) + **stop-on-reply**, and a re-engagement template that reopens the window + resumes the flow. Proven by `drip_stops_on_reply`, `reengagement_reopens_window_and_resumes`.

## 2. Required reading
1. `sprints/STATE.md`; `sprints/sprint-5/PLAN.md` § Story `S5-03` + § 0.
2. RFC `02-...` **§4.7**, **REQ-13**; `03-...` **§6.5** (`drip.scheduleNext`, stop-on-reply, re-engagement reopens window).
3. Source:
   - `packages/kuralle-engagement/src/scheduler.ts` (S5-01) — `Scheduler.enqueue/cancel`, `SendJob`.
   - `packages/kuralle-engagement/src/broadcast.ts` (S5-02) — the pipeline-send pattern for a template.
   - `packages/kuralle-messaging/src/adapter/window-store.ts` — `WindowStore.recordInbound`/`get` (re-engagement reopens the window when the customer replies).
   - `packages/kuralle-core/src/session/SessionStore.ts` — campaign state (`stoppedOnReply`) stored in the conversation session's `workingMemory`.
   - `OutboundPipeline` / `OutboundTemplate` (S1/S2).

> `bun run build` first (S5-01 + S5-02 in dist).

## 3. Specs
**`engagement/src/drip.ts`:**
```ts
export interface DripStep { template: OutboundTemplate; delayMs: number; }

export interface DripCampaignState { id: string; step: number; stoppedOnReply?: boolean; }

export function createDrip(opts: {
  scheduler: Scheduler;
  pipeline: OutboundPipeline;
  sessionStore: SessionStore;        // for the stoppedOnReply flag (conversation-keyed)
  platform: string;
  windowStore?: WindowStore;         // re-engagement reopens window on reply
}): {
  scheduleNext(threadId: string, step: DripStep): Promise<string | null>;   // null if stopped
  stopOnReply(threadId: string): Promise<void>;                              // set stoppedOnReply=true
};
```
- `scheduleNext(threadId, step)`: load the campaign state from the session; if `stoppedOnReply` → return `null` (enqueue nothing). Else `scheduler.enqueue({kind:'drip-step', payload:{threadId, ...}}, {delayMs: step.delayMs})` (the job, when it fires, sends `step.template` through the pipeline) → return the jobId.
- `stopOnReply(threadId)`: set `stoppedOnReply = true` in the session (called from the inbound path on a customer reply).
- **Re-engagement:** a scheduled step sends an approved template through the pipeline (window-agnostic). When the customer replies (normal inbound), `windowStore.recordInbound(threadId, now)` reopens the window and the resumed flow continues. Expose/test this seam: after a re-engagement send + an inbound `recordInbound`, `windowStore.get(threadId)` is open.

**Modify** `engagement/src/index.ts` — export `createDrip`, `DripStep`, `DripCampaignState`.
**Create** `engagement/test/drip.test.ts`.

## 4. Acceptance criteria
1. `createDrip(...)` per §3; `scheduleNext` enqueues via the Scheduler with `step.delayMs`; respects `stoppedOnReply`.
2. **`drip_stops_on_reply`**: after `stopOnReply(threadId)`, `scheduleNext` returns `null` and enqueues nothing (assert the scheduler's enqueue was NOT called / no job scheduled).
3. **`reengagement_reopens_window_and_resumes`**: a re-engagement step sends a `{kind:'template'}` through the pipeline (recording sink sees it); then `windowStore.recordInbound(threadId, now)` (simulating the customer's reply) ⇒ `windowStore.get(threadId)` is `{open:true}`; the next drip step (or flow) can proceed. (Use a deterministic timer per S5-01 — manual-trigger or tiny delay.)
4. `bun run build` + `typecheck:all` green; `bun test packages/kuralle-engagement` green.

## 5. What NOT to do
- No changes to the scheduler (S5-01) or broadcast/ledger (S5-02) — compose them.
- No flaky wall-clock test (use the injectable timer / manual trigger).
- No `any`/`@ts-ignore`/`--no-verify`/silent catch.

## 6. Validation contract (`.handoff/proof-s5-03.json`)
`assertions_required`: `REQ-13`, `test:drip_stops_on_reply`, `test:reengagement_reopens_window_and_resumes`, `cmd:typecheck_all`.

| claim_id | command | satisfies_assertions |
|----------|---------|----------------------|
| drip-test | `bun test packages/kuralle-engagement/test/drip.test.ts` | REQ-13, test:drip_stops_on_reply, test:reengagement_reopens_window_and_resumes |
| eng-suite | `bun test packages/kuralle-engagement` | REQ-13 (regression) |
| typecheck | `bun run typecheck:all` | cmd:typecheck_all |

### PROOF SCHEMA CHEAT-SHEET (follow exactly)
- `claims[].type` ∈ **`test_suite`|`typecheck`|`lint`|`http`|`custom_command`|`ui_recording`|`file_exists`** only.
- Each claim: **`id`** (NOT `claim_id`) = sidecar basename (`.handoff/proof-s5-03-<id>.stdout`) + `stdout_sidecar`, `command`, `cwd`, `exit_code`, `stdout_sha256`, `satisfies_assertions`.
- `commands_run[]` `purpose`=`"verification"`; `claim_id` matches a `claims[].id`. `assertions_satisfied`==`assertions_required`. Sentinel `echo "DONE $(git rev-parse HEAD) proof=.handoff/proof-s5-03.json" > .handoff/result-s5-03.done`.

## 7. Demo artifact
`sprints/sprint-5/artifacts/s5-03-tests.txt` — named tests + typecheck tail. **`git add` it.**

## 8. Report back
Files, commit sha, proof slug `s5-03`, DoD, demo, trade-offs (esp. campaign-state storage + the re-engagement seam you tested). **No `*-implementation-notes.md`.** No PR.

## 9. If stuck
- Keep the re-engagement test to the observable seam (template sent through pipeline; recordInbound reopens window) rather than a full live runtime resume if that needs a real model — document what you exercised.
- Baseline green pre-story. No shortcuts.
