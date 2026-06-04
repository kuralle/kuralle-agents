# Proceed Evidence — `S1-01` breaking text-delta lifecycle flip + migrate all consumers

> Manager artifact — Phase A. The highest-stakes story in the program (breaking protocol flip, ~70-site atomic change).

## Story
- **Id:** `S1-01`
- **Commit:** `c1c41fe` — `[S1-01] breaking text-delta lifecycle flip + migrate all consumers` (86 files, +294/−157)
- **IC slug:** `stream-s1-01` (worker: cursor)

## Proceed checklist (manager — INDEPENDENTLY re-verified, not trusting IC chat or proof)
- [x] **grep-clean** — `grep -rn "type: 'text-delta', text" packages --include=*.ts | grep -v /dist/` returns EMPTY; no `.text` reads left on text-delta. No old shape anywhere.
- [x] **All three unions flipped** — `types/stream.ts:10-13`, `types/voice.ts:266-269`, `types/processors.ts:93-96` (`AgentStreamPart`, per O1) carry only the four lifecycle variants.
- [x] **Producers emit the O4 lifecycle trio** — e.g. `TextDriver.ts:43-45` (blocked) + `:147-149` (normal) emit `text-start`/`text-delta{id,delta}`/`text-end` with a shared per-message `id`.
- [x] **`typecheck:all` no NEW failures** — manager ran the guard: exactly the 4 frozen baseline configs fail, core/test still 5 errors. The breaking flip introduced ZERO new red across 86 files.
- [x] **Full `bun run test` green** — manager ran it: exit 0, 0 fail across every package. This is the completeness backstop — a missed/mis-migrated site would fail it.
- [x] **`bun run build` exit 0.**
- [x] **REQ-12 preserved** — `extractionTurn.ts` is NOT in the commit (untouched); still emits zero text lifecycle events.
- [x] **RFC amended (O1, DoD #4)** — REQ-6 updated to "all three unions"; new §4.2.1 documents `AgentStreamPart` with the exact rationale. **B-07** added to WBS (possible dead hook surface).
- [x] **No suppression** — `git show HEAD | grep -cE "@ts-ignore|@ts-expect-error|as any|as unknown as|eslint-disable"` = 0. No `--no-verify`. No compat alias (REQ-11).
- [x] **Scope clean** — 86 files, all under `packages/`, `docs/`, `sprints/`. No stray repo-root files.
- [x] `verify-handoff-proof.sh stream-s1-01` → `PROOF_OK` (3 claims, 7 assertions) **after manager repair** (see notes).

**Verdict:** `PROCEED`

## One-line summary
Breaking `text-delta` → `text-start/delta{id,delta}/end/cancel` lifecycle flipped across all 3 unions + 86 sites migrated; typecheck:all no-new-failures, full test green, RFC amended, zero suppression · commit `c1c41fe`.

## Notes (carry to Phase B / `/delegate-review`)
- **Proof hygiene (recurring):** the cursor IC's proof was INVALID on submission — `commands_run` rows lacked `claim_id`, the `grep-clean` claim was garbage (`command: "rg grep-clean"`, no sidecar, wrong exit semantics — a clean grep exits 1, but the schema wants exit 0). Manager **independently re-ran every claim** (grep-clean via an exit-0 wrapper, build, test, guard — all pass) and repaired the proof to PROOF_OK. The independent re-run is the real gate; the proof is corroboration. Both S0-03 and S1-01 had this — S1-02/03 briefs should hand the IC a filled proof template or accept manager re-verification as primary.
- **`/delegate-review` recommended (WBS):** the breaking-flip blast radius warrants an adversarial second opinion. Run in Phase B before closeout — focus on (a) any consumer that silently drops text vs. a real migration, (b) REQ-7 single start/end correctness in the one-shot producers, (c) whether `AgentStreamPart`/`Hook.onStreamPart` is truly dead (B-07).
- S1-01 emits one delta per message (protocol flip only). True multi-delta streaming is S1-03 (`TextDriver`+`speakGated`); native voice = Sprint 2; cascaded TTFT = Sprint 3 (adapter is compile-only here).
