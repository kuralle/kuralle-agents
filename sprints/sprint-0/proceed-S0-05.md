# Proceed Evidence — `S0-05` A0.5 Terminal handoff targets

> **Manager artifact — Phase A only.** Confirms this story may proceed. Phase A complete after this.

---

## Story

- **Id:** `S0-05`
- **Commit:** `5aafa8f` — `[S0-05] A0.5 terminal handoff targets`
- **IC slug:** `s0-05` · **Worker:** cursor (`--model auto`)

---

## Proceed checklist (manager — read diff, did not trust IC chat)

- [x] **Diff read** — scope matches brief §3: `core/src/runtime/Runtime.ts` only (+`HarnessConfig.terminalHandoffTargets?`, +private `Set` defaulting to `['human']`, +terminal branch in the `handoff` block) + new test `core-flow/terminal-handoff.test.ts`. `runFlow`/`hostLoop`/`stream.ts`/`ctx.ts` untouched. `HarnessStreamPart` unchanged (emits the existing `handoff` variant).
- [x] **Design correctness** — terminal check sits **before** `handoffCount += 1` and the `agentsById.get(loopResult.to)` throw (lines 178-181), so `escalate→'human'` no longer hits the missing-agent throw. Emits `{type:'handoff', targetAgent, reason}`, sets `status='paused'`, persists, `break`s → the `finally` (`closeRun` + `done` emit) still runs. Non-terminal handoff path entirely unchanged.
- [x] **`.handoff/proof-s0-05.json`** + 3 sidecars; `verify-handoff-proof.sh s0-05` → **`PROOF_OK`** (3 claims, 3 assertions) — **first-try clean** (both hardening notes — claim `id`/sidecar + `purpose:"verification"` — worked).
- [x] **`assertions_satisfied == assertions_required`** (`REQ-23`, `test:escalate_to_human_does_not_throw`, `cmd:typecheck_all`).
- [x] **Independent manager verification (empirical):** `bun run build` exit 0; terminal-handoff test → **2 pass / 0 fail**; `core-flow`+`core-agent` → **15 pass / 0 fail**; **full `bun test packages/kuralle-core` → 372 pass / 0 fail** (no regression to the handoff path from the additive branch).
- [x] **No `--no-verify` / type-suppression** in diff.
- [x] **Demo artifact** `sprints/sprint-0/artifacts/s0-05-tests.txt` exists.

**Verdict:** `PROCEED` — **Phase A complete (all 5 stories `PROCEED`).**

---

## One-line summary

`Runtime.terminalHandoffTargets` (default `['human']`) pauses + emits a `handoff` part instead of throwing on `escalate→'human'` · 372 core tests green · proof `s0-05` · commit `5aafa8f`.

---

## Notes

- **Clean proof first try** — the brief's `purpose:"verification"` + claim `id`/sidecar notes pre-empted both prior proof-format errors.
- **Test path used:** confirm in Phase B which path the IC's test drives (escalate→signal→resume vs direct `{handoff:'human'}`) — either satisfies REQ-23; the test file is 149 lines (2 tests), reviewed at gate as passing.
- **Double-emit (documented, benign):** for an explicit `{handoff:'human'}` transition, `runFlow.ts:157` already emits a `handoff` part and Runtime now emits again — informational/idempotent, out of scope per PLAN §5. Worth a one-line note in the sprint review.
- **Stray notes file:** `s0-05-implementation-notes.md` at root — 5th of the batch; Phase B cleanup.
