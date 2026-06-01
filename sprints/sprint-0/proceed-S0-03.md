# Proceed Evidence — `S0-03` A0.2 `RunOptions.selection` propagation

> **Manager artifact — Phase A only.** Confirms this story may proceed. Not a gate-worker review.

---

## Story

- **Id:** `S0-03`
- **Commit:** `755eb21` — `[S0-03] A0.2 RunOptions.selection propagation`
- **IC slug:** `s0-03` · **Worker:** cursor (`--model auto`)

---

## Proceed checklist (manager — read diff, did not trust IC chat)

- [x] **Diff read** — scope matches brief §3: `types/selection.ts` (new `ResolvedSelection`), `types/index.ts` (+export), `Runtime.ts` (`RunOptions.selection` + threaded into `openRun`), `openRun.ts` (merge `formData`→`runState.state` + persist **before** the input block; `effectiveInput = selection.id ?? input` on both activeFlow + no-activeFlow paths), new test `core-durable/run-options-selection.test.ts`. No out-of-scope edits; `runFlow`/`hostLoop`/`ctx` untouched; effect log untouched.
- [x] **Design correctness** — merge lands after `signalDelivery` reload and before any effect (turn start), persisted via `putRunState` → durable-replay safe; shallow merge `{ ...runState.state, ...formData }` is idempotent on resume; `selection.id` precedence over `opts.input` matches §6.3. Absent `selection` ⇒ `effectiveInput === options.input` (today's behavior exactly).
- [x] **`.handoff/proof-s0-03.json`** + 3 sidecars; `verify-handoff-proof.sh s0-03` → **`PROOF_OK`** (3 claims, 5 assertions) — **first-try clean** (brief hardening on claim `id`/`stdout_sidecar` worked).
- [x] **`assertions_satisfied == assertions_required`** (`REQ-20`, `test:selection_formdata_lands_in_flow_state`, `test:selection_id_is_routing_input`, `test:selection_replay_safe`, `cmd:typecheck_all`).
- [x] **Independent manager verification (empirical):** `bun run build` exit 0; selection test → **3 pass / 0 fail**; `core-durable` regression → **10 pass / 0 fail**; `core-flow` regression → **7 pass / 0 fail**. No regression from the `openRun` change.
- [x] **No `--no-verify` / type-suppression** in diff.
- [x] **Demo artifact** `sprints/sprint-0/artifacts/s0-03-tests.txt` exists.

**Verdict:** `PROCEED`

---

## One-line summary

`RunOptions.selection` merges `formData` into `runState.state` before first effect and routes `selection.id` as `input`, durable-replay safe · 3 selection + 17 regression tests green · proof `s0-03` · commit `755eb21`.

---

## Notes

- **Clean proof first try** — no manager repair needed (vs S0-01/S0-02). The hardened brief (explicit `id` = sidecar basename, `stdout_sidecar` required, `id` not `claim_id`) resolved the recurring cursor proof-format issue.
- **`ResolvedSelection` is now the canonical core type** — S0-04's `ChannelPolicy.resolveInbound` and (Sprint 3) messaging's `InboundResolverChain` import it from `@kuralle-agents/core`. The S0-04 brief already references it.
- **Stray notes file** — `s0-03-implementation-notes.md` at repo root (committed), same minor convention drift as S0-02. Will batch-address in Phase B (relocate or remove the `s0-0N-implementation-notes.md` files).
