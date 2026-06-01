# Story Brief — `S0-05` A0.5 Terminal handoff targets (rev4, R-08-B/REQ-23)

> **You are the IC engineer (`cursor` worker — fresh process, clean context).** Self-contained. Read end-to-end before coding. Ambiguity/contradiction with disk → **stop and ask**.
>
> **Atomic-commit:** finish → `[S0-05] A0.5 terminal handoff targets` on **`plan/whatsapp-engagement`** (confirm `git branch --show-current`). No push, no `main`, one commit.
>
> **Runtime:** Bun. `bun test`.

---

## 1. Goal

`Runtime` gains a configured set of **terminal handoff targets** (default `['human']`). When the host loop returns a handoff whose target is terminal, the runtime **pauses the run and emits a `handoff` stream part** instead of resolving an agent — eliminating the `Runtime.ts:178-180` missing-agent throw on `escalate→'human'`. Non-terminal handoffs are unchanged. Proven by `escalate_to_human_does_not_throw`.

---

## 2. Required reading (in this order)

1. `sprints/STATE.md`; `sprints/sprint-0/PLAN.md` § Story `S0-05` + § 0 (note: `escalate` already pauses via `ctx.signal('__escalate')`; the `handoff` stream part already exists).
2. RFC: `rfcs/whatsapp-engagement/02-requirements-interfaces.md` **REQ-21** + **REQ-23** + **§4.11** "Handoff-to-human seam (R-08-B, rev4)"; `04-tasks-validation.md` **A0.5** + **§9.1** `human_owned_inbound_does_not_run_flow` (the no-throw half is this story; the ownership gate is Sprint 4).
3. Source (the contract):
   - `packages/kuralle-core/src/runtime/Runtime.ts`:
     - `HarnessConfig` (lines 37-49) — you add `terminalHandoffTargets?: string[]`.
     - constructor (71-77) — store the terminal set.
     - `run()` handoff handling (**lines 172-200**): `if (loopResult.kind === 'handoff')` → increments `handoffCount`, then `this.agentsById.get(loopResult.to)` → **throws at 179-180 if not found**. This throw is the bug for `'human'`.
     - the `finally` block (216-233) already runs `closeRun` + emits `{type:'done'}` — your `break` must let it run.
   - `packages/kuralle-core/src/types/stream.ts` — **line 12** already has `{ type:'handoff'; targetAgent:string; reason?:string }`. You emit this existing variant — **no `HarnessStreamPart` change**.
   - `packages/kuralle-core/src/flow/runFlow.ts` — **lines 161-163**: `escalate` does `await ctx.signal('__escalate', {meta:{reason}})` (a durable pause) then `return { kind:'handoff', to:'human', reason }`. Note it does **not** emit a handoff part. (Line 157, the explicit `{handoff}` transition path, *does* emit one.)
   - `packages/kuralle-core/src/runtime/hostLoop.ts` — returns `{ kind:'handoff', to, reason }` (lines 89-90, 134-136); some paths emit a handoff part before returning.
   - Test patterns: `packages/kuralle-core/test/core-flow/` and `core-durable/` — find an existing flow-run test that drives a flow to completion/pause with a `MemoryStore`, and how `__signal`/resume is delivered (grep `__escalate`, `signal`, `signalDelivery`, `waitingFor`).

---

## 3. Files you will create or modify

**Modify:**
- `packages/kuralle-core/src/runtime/Runtime.ts`:
  1. `HarnessConfig`: add `terminalHandoffTargets?: string[];`.
  2. Constructor: add a private field, e.g. `private readonly terminalHandoffTargets: Set<string>;` set to `new Set(config.terminalHandoffTargets ?? ['human'])`.
  3. In `run()`, inside `if (loopResult.kind === 'handoff') {` — **before** `handoffCount += 1` and the `agentsById.get` lookup — add:
     ```ts
     if (this.terminalHandoffTargets.has(loopResult.to)) {
       emit({ type: 'handoff', targetAgent: loopResult.to, reason: loopResult.reason });
       runCtx.runState.status = 'paused';
       await runCtx.runStore.putRunState(runCtx.runState);
       break; // terminal handoff: pause + emit; do not resolve an agent, do not throw
     }
     ```
     The existing `finally` (closeRun + `done` emit) still runs after the `break`.

**Create:**
- `packages/kuralle-core/test/core-flow/terminal-handoff.test.ts` (or `core-durable/` — put it where the helper that drives a flow run lives; reuse the existing helper).

**Do not touch:** `runFlow.ts`, `hostLoop.ts`, `stream.ts`, `ctx.ts`, or the existing emit sites. This is a surgical, additive change in `Runtime.ts` only.

---

## 4. Acceptance criteria (priority order)

1. `HarnessConfig.terminalHandoffTargets?: string[]` additive optional; default `['human']` when omitted.
2. A handoff to a terminal target: emits exactly one `{type:'handoff', targetAgent, reason}` (for the `escalate` path, which doesn't emit elsewhere), sets `runState.status = 'paused'`, persists, and does **not** throw a missing-agent error, does **not** increment `handoffCount`, does **not** resolve an agent.
3. A handoff to a **non-terminal** target (an agent that exists) is unchanged — resolves and switches as today. (Regression: existing handoff tests stay green.)
4. **`escalate_to_human_does_not_throw`** — drive a flow whose node returns `{ escalate: 'human' }` (or `{ handoff: 'human' }`); after the `__escalate` signal is delivered on resume so the flow returns `kind:'handoff' to:'human'`, the run completes **without** throwing `Handoff target agent not found: human`; assert `status === 'paused'` was persisted and a `handoff` part with `targetAgent:'human'` was emitted on the turn's event stream. (Drive via a flow `action`/`decide` node — no live model needed.)
5. `bun run build` (rebuild core) + `bun run typecheck:all` green (proves the additive change breaks no exhaustive switch — there is none, `handoff` already exists). `bun test packages/kuralle-core` green.

> **Note on the test mechanics:** `escalate` first *suspends* on `ctx.signal('__escalate')` (the first `run()` pauses with `waitingFor:'__escalate'`). The `{kind:'handoff', to:'human'}` is only reached on the **resume** turn after that signal is delivered (via `RunOptions.signalDelivery` / the resume path). Study how the existing durable tests deliver a signal and resume, then assert the resume turn does not throw. If driving the full escalate→signal→resume path is hard to set up, an acceptable equivalent is a flow whose node returns `{ handoff: 'human' }` directly (no `__escalate` signal) — that also yields `loopResult.kind==='handoff' to:'human'` and hits the same Runtime branch; document which path your test exercises. The required outcome is identical: no missing-agent throw, run pauses, handoff part emitted.

---

## 5. Codebase conventions

- ESM `.js` specifiers. `bun:test`. Reuse existing flow-run test helpers (`MemoryStore`, runtime construction) — read them first.
- Collect emitted parts via the `TurnHandle.events` async iterable (see how existing tests consume `handle.events` / await the handle).

---

## 6. What NOT to do

- Do not change `stream.ts` (`handoff` variant exists).
- Do not refactor the `runFlow`/`hostLoop` emit sites (a possible double-emit for the explicit `{handoff:'human'}` path is benign and out of scope — see PLAN §5; document it, don't fix it).
- Do not add an ownership store / inbound gate (Sprint 4).
- No `@ts-ignore`, `--no-verify`, silent catch.

---

## 7. Validation contract (`.handoff/proof-s0-05.json`)

`assertions_required`:
- `REQ-23`
- `test:escalate_to_human_does_not_throw`
- `cmd:typecheck_all`

### Proof commands

| claim_id | command | satisfies_assertions |
|----------|---------|----------------------|
| handoff-test | `bun test packages/kuralle-core/test/core-flow/terminal-handoff.test.ts` | REQ-23, test:escalate_to_human_does_not_throw |
| core-suite | `bun test packages/kuralle-core` | REQ-23 (regression: non-terminal handoff unchanged) |
| typecheck | `bun run typecheck:all` | cmd:typecheck_all |

**Proof schema gotcha:** `claims[].type` ∈ `{test_suite, typecheck, lint, http, custom_command, ui_recording, file_exists}` exactly — no invented types. `test_suite` for `bun test`, `typecheck` for `typecheck:all`. Each `claims[]` entry needs: `id` (must equal the sidecar basename — claim `id:"handoff-test"` → sidecar `.handoff/proof-s0-05-handoff-test.stdout`), `stdout_sidecar` (that path), `command`, `cwd`, `exit_code`, `stdout_sha256` (sha256 of the sidecar), `satisfies_assertions`. Use the field name **`id`**, NOT `claim_id`. Each `commands_run[]` row's `purpose` MUST be the literal enum `"verification"` (not free-text like `"REQ-23 ..."`) and its `claim_id` must match a `claims[].id`. `assertions_satisfied == assertions_required`. Write sidecars + `.handoff/result-s0-05.done` (`DONE <sha> proof=.handoff/proof-s0-05.json`).

---

## 8. Demo artifact

`sprints/sprint-0/artifacts/s0-05-tests.txt` — passing `escalate_to_human_does_not_throw` + typecheck tail. Commit it.

---

## 9. Report back

Files changed, commit sha, proof slug `s0-05`, DoD ticked, demo path, one paragraph of trade-offs (esp. which test path you drove — escalate+signal+resume vs direct `{handoff:'human'}` — and the double-emit observation). No PR.

---

## 10. If stuck

- Driving the signal/resume path is the trickiest part — if blocked, fall back to the direct `{handoff:'human'}` flow node (§4 note) and say so. Do not fake the assertion.
- Baseline green pre-story; a failure outside `Runtime.ts` should trace to your change. Diagnose, don't bypass.
