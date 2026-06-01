# Story Brief — `S5-01` E1: Scheduler interface + in-process impl

> **IC engineer (`cursor`, fresh process).** Self-contained. Ambiguity → **stop and ask**.
> **Atomic-commit:** `[S5-01] E1 Scheduler + in-process impl` on **`plan/whatsapp-engagement`**. No push/`main`, one commit. **Bun.**

## 1. Goal
A `Scheduler` interface + `InProcessScheduler` (timer-based enqueue/cancel) in `@kuralle-agents/engagement`, with documented production adapters. Proven by `scheduler_enqueue_fires`, `scheduler_cancel_prevents` (deterministic — no flaky wall-clock).

## 2. Required reading
1. `sprints/STATE.md`; `sprints/sprint-5/PLAN.md` § Story `S5-01` + § 0 (esp. the determinism note).
2. RFC `02-...` **§4.7** (`Scheduler`); **REQ-13**; `03-...` **§6.5** (drip uses `scheduler.enqueue({delayMs})`).
3. Source: `packages/kuralle-engagement/src/index.ts` (export); existing engagement test style (`engagement/test/*`).

> `bun run build` first.

## 3. Specs
**`engagement/src/scheduler.ts`:**
```ts
/** A unit of deferred work (broadcast step / drip step). Shape is engagement-internal. */
export interface SendJob {
  kind: string;                 // e.g. 'drip-step' | 'broadcast'
  payload: Record<string, unknown>;
}

export interface Scheduler {
  enqueue(job: SendJob, opts?: { delayMs?: number }): Promise<string>;  // returns jobId
  cancel(jobId: string): Promise<void>;
}

/**
 * Default in-process scheduler (timer-based). For single-process/dev.
 * Production adapters (interface-compatible, not implemented here):
 *   - BullMQ (Redis-backed queue)
 *   - Google Cloud Tasks
 *   - cron / system scheduler
 * Inject a durable adapter for multi-process / serverless.
 */
export function createInProcessScheduler(opts?: {
  run: (job: SendJob) => void | Promise<void>;     // what to do when a job fires
  timer?: { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };  // injectable for tests
}): Scheduler { ... }
```
- `enqueue(job, {delayMs})`: schedule `opts.run(job)` after `delayMs` (default 0). Return a unique jobId (a counter — do NOT use `Math.random`/`Date.now` for the id; use an incrementing counter so tests are deterministic). Track the timer handle by jobId.
- `cancel(jobId)`: clear the timer so the job never fires.
- Default `timer` uses `setTimeout`/`clearTimeout`; tests inject a manual timer (a fake that records scheduled fns + lets the test trigger them) for determinism — OR use a 1–5ms real delay + `await`. Prefer the **injectable timer** so tests are not wall-clock-dependent.
- Note: per repo rules, `Math.random()`/argless `Date.now()` are discouraged for ids in deterministic code — use a counter.

**Modify** `engagement/src/index.ts` — export `Scheduler`, `SendJob`, `createInProcessScheduler`.
**Create** `engagement/test/scheduler.test.ts`.

## 4. Acceptance criteria
1. `Scheduler` + `SendJob` + `createInProcessScheduler` per §3; jobId is a deterministic counter.
2. `scheduler_enqueue_fires`: an enqueued job runs (its `run` callback observed) — via an injected manual timer (trigger it) or a tiny real delay.
3. `scheduler_cancel_prevents`: a cancelled job never runs.
4. Doc comment lists production adapters.
5. `bun run build` + `typecheck:all` green; `bun test packages/kuralle-engagement` green.

## 5. What NOT to do
- No broadcast/drip logic (S5-02/03) — only the scheduler.
- No `Math.random`/argless `Date.now()` for ids (use a counter); no flaky wall-clock test.
- No `any`/`@ts-ignore`/`--no-verify`/silent catch.

## 6. Validation contract (`.handoff/proof-s5-01.json`)
`assertions_required`: `REQ-13`, `test:scheduler_enqueue_fires`, `test:scheduler_cancel_prevents`, `cmd:typecheck_all`.

| claim_id | command | satisfies_assertions |
|----------|---------|----------------------|
| sched-test | `bun test packages/kuralle-engagement/test/scheduler.test.ts` | REQ-13, test:scheduler_enqueue_fires, test:scheduler_cancel_prevents |
| eng-suite | `bun test packages/kuralle-engagement` | REQ-13 (regression) |
| typecheck | `bun run typecheck:all` | cmd:typecheck_all |

### PROOF SCHEMA CHEAT-SHEET (follow exactly)
- `claims[].type` ∈ **`test_suite`|`typecheck`|`lint`|`http`|`custom_command`|`ui_recording`|`file_exists`** only.
- Each claim: **`id`** (NOT `claim_id`) = sidecar basename (`.handoff/proof-s5-01-<id>.stdout`) + `stdout_sidecar`, `command`, `cwd`, `exit_code`, `stdout_sha256`, `satisfies_assertions`.
- `commands_run[]` `purpose`=`"verification"`; `claim_id` matches a `claims[].id`. `assertions_satisfied`==`assertions_required`. Sentinel `echo "DONE $(git rev-parse HEAD) proof=.handoff/proof-s5-01.json" > .handoff/result-s5-01.done`.

## 7. Demo artifact
`sprints/sprint-5/artifacts/s5-01-tests.txt` — named tests + typecheck tail. **`git add` it.**

## 8. Report back
Files, commit sha, proof slug `s5-01`, DoD, demo, trade-offs (esp. the determinism approach: injectable timer vs short delay). **No `*-implementation-notes.md`.** No PR.

## 9. If stuck
- If `setTimeout` typing differs under Bun/Node, type the timer handle as `ReturnType<typeof setTimeout>` or `unknown`; the injectable-timer path avoids ambient-type issues.
- Baseline green pre-story (864 tests). No shortcuts.
