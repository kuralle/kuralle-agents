# Proceed Evidence — `S0-02` A0.1 inbound types + customer identity

> **Manager artifact — Phase A only.** Confirms this story may proceed. Not a gate-worker review.

---

## Story

- **Id:** `S0-02`
- **Commit:** `c53197f` — `[S0-02] A0.1 inbound types + customer identity`
- **IC slug:** `s0-02` · **Worker:** cursor (`--model auto`)

---

## Proceed checklist (manager — read diff, did not trust IC chat)

- [x] **Diff read** — scope matches brief §3: `messages.ts` (+`customerId` required, +`button?`, +`formResponse?`), `session-resolver.ts` (no double-prefix; `userId = customerId ?? from.id`; doc updated), `normalizer.ts` (+`nfm_reply` on `NormalizedMessage.interactive`), `whatsapp/client.ts` (+`customerId`/`button`/`formResponse` + failure-safe `parseNfmReply`), `messenger/client.ts` + `instagram/client.ts` (+`customerId`), and test fixtures updated (`base-client`, `session-resolver-chain`, `unhappy-paths`) + new tests in `whatsapp-client.test.ts` (+63) and `session-resolver.test.ts` (+61/-revised). No out-of-scope edits; no `core` touched.
- [x] **`parseNfmReply` quality** — guards `!response_json`, non-object, array, and `JSON.parse` throw → all return `undefined`. Failure-safe per brief §3; not a silent swallow (it is the documented failure mode).
- [x] **`customerId` cascade handled** — all 3 meta clients set it; all test literals updated; no out-of-scope `InboundMessage` producer found. Build compiles with the required field.
- [x] **`.handoff/proof-s0-02.json`** + 4 sidecars; `verify-handoff-proof.sh s0-02` → **`PROOF_OK`** (4 claims, 5 assertions) *after manager repaired claim fields (see Notes).*
- [x] **`assertions_satisfied == assertions_required`** (`REQ-19`, `REQ-20`, `test:session_id_not_double_prefixed`, `test:nfm_reply_and_template_button_parsed`, `cmd:typecheck_all`).
- [x] **Independent manager verification (empirical):** `bun run build` exit 0; `bun test packages/kuralle-messaging` → **418 pass / 0 fail**; `bun test packages/kuralle-messaging-meta` → **303 pass / 0 fail**. Both named tests confirmed present (`session_id_not_double_prefixed`, `nfm_reply_and_template_button_parsed`). Sidecar sha256 of all 4 claims match the actual sidecar files.
- [x] **No `--no-verify` / type-suppression** in diff.
- [x] **Demo artifact** `sprints/sprint-0/artifacts/s0-02-tests.txt` exists.

**Verdict:** `PROCEED`

---

## One-line summary

`InboundMessage` carries `customerId`/`button`/`interactive.formResponse`; WA parses `nfm_reply` safely; resolver no longer double-prefixes · 721 messaging tests green · proof `s0-02` · commit `c53197f`.

---

## Notes

- **Proof-format correction (manager, not a substantive defect — 2nd occurrence):** the IC's `claims[]` used `claim_id` instead of the schema field `id` and omitted `stdout_sidecar`, so the verifier looked for `proof-s0-02-claim-0.stdout` and failed. The four sidecars existed under their correct names with sha256 **matching the claim hashes exactly**, and `commands_run[]` was correct. I renamed `claim_id`→`id` and added `stdout_sidecar` per claim (no hash/sidecar/command touched), and independently re-ran both test suites before accepting. Encoding fix, not a re-run of failed work.
- **Brief hardening applied:** the remaining briefs (S0-03/04/05) now state explicitly that each claim needs an `id` matching `proof-<slug>-<id>.stdout` and a `stdout_sidecar` field — to stop this recurring. (Cursor's proof discipline is the weak spot; the work itself has been clean both stories.)
- **Stray file:** IC left a top-level `s0-02-implementation-notes.md` (committed). Harmless but slightly out of convention (S0-01 kept its notes in `.handoff`/result). Not blocking; will note in Phase B review whether to relocate/remove.
