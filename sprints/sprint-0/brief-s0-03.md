# Story Brief — `S0-03` A0.2 `RunOptions.selection` propagation (R-03/REQ-20)

> **You are the IC engineer (`cursor` worker — fresh process, clean context).** Self-contained brief. Read end-to-end before coding. Ambiguity or contradiction with disk → **stop and ask**.
>
> **Atomic-commit:** finish → commit atomically `[S0-03] A0.2 RunOptions.selection propagation` on **`plan/whatsapp-engagement`** (confirm `git branch --show-current`). No push, no `main`, one commit.
>
> **Runtime:** Bun. `bun test`.

---

## 1. Goal

Add an additive optional `selection?: ResolvedSelection` to core's `RunOptions`. At turn start the runtime merges `selection.formData` into the run's flow state (`runState.state`) **and persists it before any effect runs** (durable-replay safe), and exposes `selection.id` as the routing `input`. Absent `selection` → behaves exactly as today. Proven by 3 unit tests.

---

## 2. Required reading (in this order)

1. `sprints/STATE.md`; `sprints/sprint-0/PLAN.md` § Story `S0-03` + § 0.
2. RFC: `rfcs/whatsapp-engagement/02-requirements-interfaces.md` **§4.8** (the exact propagation mechanism), **REQ-20**; `rfcs/whatsapp-engagement/03-pseudocode-blueprint.md` **§6.3** (router calls `runtime.run({ input, sessionId, userId, selection })`; "merges `selection.formData` into flow state and exposes `selection.id` as `input`").
3. `rfcs/whatsapp-engagement/04-tasks-validation.md` **A0.2** + **§9.1** tests `selection_formdata_lands_in_flow_state`, `selection_id_is_routing_input`.
4. Source (the contract):
   - `packages/kuralle-core/src/runtime/Runtime.ts` — `RunOptions` (lines 51-61), `Runtime.run` calls `openRun(...)` (lines 95-105) passing `input`, `userId`, etc. `RunOptions`/`HarnessConfig` are exported from `src/index.ts` (lines 262-266).
   - `packages/kuralle-core/src/runtime/openRun.ts` — `OpenRunOptions` (12-22); session/runState load (39-62); **the input-queueing block (77-93)**: if `runState.activeFlow` → `setPendingUserInput`; else append a `{role:'user', content: input}` message. This is where `input` is consumed.
   - `packages/kuralle-core/src/runtime/durable/types.ts` — `RunState` (line 25): `state: Record<string, unknown>` (line 32) is the **flow state**; `activeFlow?` (30); `status` (28).
   - `packages/kuralle-core/src/flow/runFlow.ts` — confirms flow nodes read `run.state` (e.g. `node.run(run.state, …)` line 83, `node.decide(structured, run.state)` line 95) — this is the object your merge lands in.
   - `packages/kuralle-core/src/types/index.ts` — uses `export *`; add your new type's re-export here.
   - Test helpers + patterns: `packages/kuralle-core/test/core-durable/{helpers.ts,session-run-store.test.ts,replay-determinism.test.ts,exactly-once.test.ts}` — mirror these (MemoryStore + `openRun` usage).

---

## 3. Files you will create or modify

**Create:**
- `packages/kuralle-core/src/types/selection.ts`:
  ```ts
  /** A structured inbound selection propagated into a run (RFC §4.8 / REQ-20). */
  export interface ResolvedSelection {
    /** Stable id (button/list id, template button payload) — exposed as the routing `input`. */
    id?: string;
    /** Flow-form submission data (e.g. WhatsApp Flow nfm_reply) merged into flow state at turn start. */
    formData?: Record<string, unknown>;
  }
  ```
- `packages/kuralle-core/test/core-durable/run-options-selection.test.ts` — the 3 tests (§4).

**Modify:**
- `packages/kuralle-core/src/types/index.ts` — add `export * from './selection.js';`.
- `packages/kuralle-core/src/runtime/Runtime.ts`:
  - `RunOptions` gains `selection?: ResolvedSelection;` (import the type).
  - In `run()`, thread `selection: opts.selection` into the `openRun(...)` call (alongside `input`).
- `packages/kuralle-core/src/runtime/openRun.ts`:
  - `OpenRunOptions` gains `selection?: ResolvedSelection;` (import the type).
  - **Merge formData (before the input block, after runState is loaded/created — i.e. before line 77):** if `options.selection?.formData` is present:
    ```ts
    runState.state = { ...runState.state, ...options.selection.formData };
    runState.updatedAt = Date.now();
    await runStore.putRunState(runState);
    ```
    This persists the merged state into `run.state` before any effect — idempotent on replay (shallow-merging the same keys yields the same object).
  - **Effective input:** compute `const effectiveInput = options.selection?.id ?? options.input;` and use `effectiveInput` (not `options.input`) in the input-queueing block (77-93) — both the `if (effectiveInput)` guard and the value queued (`setPendingUserInput(..., effectiveInput)` / `content: effectiveInput`). `selection.id` takes precedence over `opts.input` for the routing string.

**Do not touch:** `runFlow`/`hostLoop`/`ctx` signatures; the effect log; messaging packages; anything outside the list. Do **not** plumb `selection` through `ctx.tool`/the effect machinery — the merge happens once in `openRun`.

---

## 4. Acceptance criteria (priority order) + the 3 tests

1. `ResolvedSelection` defined in core and exported from the package root (`import { ResolvedSelection } from '@kuralle-agents/core'` resolves). (§4.8)
2. `RunOptions.selection` and `OpenRunOptions.selection` are additive optionals; omitting `selection` reproduces today's behavior exactly (regression: existing core tests stay green).
3. **`selection_formdata_lands_in_flow_state`** — call `openRun` (or `runtime.run`) with `selection: { formData: { cart: 2, addr: 'Home' } }`; assert the persisted `runState.state` contains `{ cart: 2, addr: 'Home' }` (merged, not replacing pre-existing keys).
4. **`selection_id_is_routing_input`** — call `openRun` with `selection: { id: 'RESUME' }` and **no** `input`; assert the queued input is `'RESUME'` (for a no-activeFlow run: a `{role:'user', content:'RESUME'}` message is appended to `runState.messages`; for an `activeFlow` run: `pendingUserInput === 'RESUME'`). Cover the no-activeFlow case at minimum; cover both if the helper makes it easy.
5. **Replay-safe** — run `openRun` twice for the same session with the same `selection.formData` (simulating a resume); assert `runState.state` is not double-applied/corrupted (idempotent) and the merged keys persist across the second open. (Mirror `replay-determinism.test.ts` style.)
6. `bun run build` (rebuild core — stale-dist gotcha) + `bun run typecheck:all` green; `bun test packages/kuralle-core` green.

---

## 5. Codebase conventions

- ESM `.js` import specifiers. `import type { ResolvedSelection } from '../types/selection.js'` in Runtime/openRun.
- Tests use `bun:test`. Reuse `core-durable/helpers.ts` for store/openRun setup — read it first; do not reinvent a MemoryStore if a helper exists.
- Match the existing `openRun` style (await `runStore.putRunState`, `Date.now()` for `updatedAt`).

---

## 6. What NOT to do

- No new `FlowNode` kind, no `runFlow`/`hostLoop` signature change (REQ-9 spirit — additive only).
- Do not change how `input` works when `selection` is absent.
- Do not merge `formData` anywhere except `runState.state` in `openRun`.
- No `@ts-ignore`, `--no-verify`, silent catch.

---

## 7. Validation contract (`.handoff/proof-s0-03.json`)

`assertions_required`:
- `REQ-20`
- `test:selection_formdata_lands_in_flow_state`
- `test:selection_id_is_routing_input`
- `test:selection_replay_safe`
- `cmd:typecheck_all`

### Proof commands

| claim_id | command | satisfies_assertions |
|----------|---------|----------------------|
| sel-tests | `bun test packages/kuralle-core/test/core-durable/run-options-selection.test.ts` | REQ-20, test:selection_formdata_lands_in_flow_state, test:selection_id_is_routing_input, test:selection_replay_safe |
| core-suite | `bun test packages/kuralle-core` | REQ-20 (regression: no `selection` = unchanged) |
| typecheck | `bun run typecheck:all` | cmd:typecheck_all |

**Proof schema gotcha:** `claims[].type` MUST be one of exactly `test_suite | typecheck | lint | http | custom_command | ui_recording | file_exists`. Use `test_suite` for `bun test …`, `typecheck` for `typecheck:all`. Do NOT invent types like `"build"`/`"shell"`/`"bun_test"`. Each `claims[]` entry needs: `id` (must equal the sidecar basename — claim `id:"sel-tests"` → sidecar `.handoff/proof-s0-03-sel-tests.stdout`), `stdout_sidecar` (that path), `command`, `cwd`, `exit_code`, `stdout_sha256` (sha256 of the sidecar), `satisfies_assertions`. Use the field name **`id`**, NOT `claim_id`. `assertions_satisfied` must equal `assertions_required`. Write sidecars + `.handoff/result-s0-03.done` (`DONE <sha> proof=.handoff/proof-s0-03.json`).

---

## 8. Demo artifact

`sprints/sprint-0/artifacts/s0-03-tests.txt` — passing output for the 3 named tests + a `typecheck:all` tail. Commit it.

---

## 9. Report back

Files changed, commit sha, proof slug `s0-03`, DoD ticked, demo path, one paragraph of trade-offs (esp. how you handled the activeFlow vs no-activeFlow input path and the replay idempotency). No PR — commit to the branch; manager reviews.

---

## 10. If stuck

- Missing referenced symbol/path → stop, report found-vs-expected.
- If merging into `runState.state` before the input block causes a pre-existing core test to fail → diagnose (likely a test that asserts exact `state` equality); report rather than bypass. Baseline was green pre-story.
- No shortcuts. If you didn't run a check, say so.
