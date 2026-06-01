# Proceed Evidence — `S0-04` A0.3/A0.4 WindowStore + ChannelPolicy + webPolicy

> **Manager artifact — Phase A only.** Confirms this story may proceed. Not a gate-worker review.

---

## Story

- **Id:** `S0-04`
- **Commit:** `0594287` — `[S0-04] A0.3/A0.4 WindowStore + ChannelPolicy + webPolicy`
- **IC slug:** `s0-04` · **Worker:** cursor (`--model auto`)

---

## Proceed checklist (manager — read diff, did not trust IC chat)

- [x] **Diff read** — scope matches brief §3: `messaging/src/adapter/window-store.ts` (new `WindowState`/`WindowStore`/`InMemoryWindowStore`), `messaging/src/index.ts` (+exports), `engagement/src/policy.ts` (`ChoiceOption`, forward-declared `SmartSendStrategist` w/ `TODO(S2-01)`, `ClosedWindowStrategy`, `ChannelPolicy`), `engagement/src/policies/web.ts` (`webPolicy`), `engagement/src/index.ts` (exports), `engagement/package.json` (+`@kuralle-agents/messaging` dep), `bun.lock`, two new tests. No `createMessagingRouter`/pipeline wiring; `WindowTracker` internals untouched; `core` untouched.
- [x] **Fail-closed verified** — `InMemoryWindowStore.get` returns `{open:false, expiresAt:null}` on a `getExpiry`→null miss; never `open:true` on miss. Matches §4.9/REQ-18.
- [x] **Forward-declarations correct** — `ChoiceOption` defined in engagement (full §4.5 shape); `SmartSendStrategist` placeholder carries the grep-able `TODO(S2-01)` for Sprint 2 replacement. `ResolvedSelection` imported from `@kuralle-agents/core` (S0-03), `InboundMessage`/`InteractiveMessage` from `@kuralle-agents/messaging`.
- [x] **`.handoff/proof-s0-04.json`** + 3 sidecars; `verify-handoff-proof.sh s0-04` → **`PROOF_OK`** (3 claims, 5 assertions) *after manager fixed `commands_run[].purpose` (see Notes).*
- [x] **`assertions_satisfied == assertions_required`** (`REQ-18`, `REQ-22`, `test:window_store_fail_closed`, `test:web_null_policy_always_open`, `cmd:typecheck_all`).
- [x] **Independent manager verification (empirical):** `bun run build` exit 0 (engagement T3 compiles against messaging T2); window-store test → **3 pass / 0 fail**; web-policy test → **1 pass / 0 fail**.
- [x] **No `--no-verify` / type-suppression** in diff.
- [x] **Demo artifact** `sprints/sprint-0/artifacts/s0-04-tests.txt` exists.

**Verdict:** `PROCEED`

---

## One-line summary

`WindowStore`/`InMemoryWindowStore` (fail-closed) in messaging + `ChannelPolicy`/`webPolicy` null adapter in engagement, no wiring · 4 tests green · proof `s0-04` · commit `0594287`.

---

## Notes

- **Proof-format correction (manager):** `commands_run[].purpose` held free-text (`"REQ-18 window_store_fail_closed"`) instead of the schema enum `verification`, so the verifier couldn't corroborate the claims. I set all three to `verification` (the schema's valid value); commands/sidecars/sha256 untouched, and I independently re-ran both tests before accepting. (Different proof-field error than S0-01/S0-02 — the brief now covers claim `id`/sidecar but not the `purpose` enum; will add to any future briefs.)
- **Forward trap carried to Sprint 3:** `ChoiceOption` lives in engagement; Sprint 3 (C1) adds it to core's `stream.ts` and may need to relocate it to core (core can't import engagement). Flagged.
- **Stray notes file:** `s0-04-implementation-notes.md` at root again — batch-cleanup in Phase B with the S0-02/S0-03 ones.
