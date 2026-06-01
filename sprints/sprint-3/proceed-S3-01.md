# Proceed Evidence — `S3-01` C1: interactive stream part + choice metadata + ChoiceOption relocation

> **Manager artifact — Phase A only.**

## Story
- **Id:** `S3-01` · **Commit:** `01767de` · **Slug:** `s3-01` · **Worker:** cursor.

## Proceed checklist (manager — read diff, did not trust IC chat)
- [x] **Diff read** — `stream.ts` (+`interactive` variant + authoritative doc-comment), `selection.ts` (+`ChoiceOption`), `flow.ts` (+`choices?` on collect/decide), `flow/emitInteractive.ts` (new helper) + `runFlow.ts` (import+call) + `reduceTransition.ts` (2 lines), `index.ts`, `engagement/src/{policy.ts,policies/web.ts}` (import ChoiceOption from core + re-export), test. Scope matches brief.
- [x] **Additive proven empirically** — `typecheck:all` green (no exhaustive-switch break over `HarnessStreamPart`); `core` suite **374 pass / 0 fail** (was 372 — +2, no regression). The `interactive_part_is_additive` test shows a default-switch consumer tolerates the new variant.
- [x] **Two-unions trap handled** — variant added to `stream.ts` only; **`voice.ts` untouched (0 diff lines)**; doc-comment states stream.ts is authoritative for runtime emit and voice.ts intentionally omits the variant.
- [x] **`ChoiceOption` relocated cleanly** — now in `core/src/types/selection.ts`, exported from core root; `engagement/policy.ts` imports from core + re-exports (`export type { ChoiceOption } from '@kuralle-agents/core'`); `web.ts` updated. No shape change.
- [x] **Emit on node entry** — `emitInteractiveOnNodeEnter(node, state, emit)` called in `runFlow` after node-enter; emits only when the collect/decide has `choices` (verified by `interactive_emitted_on_node_entry` incl. the no-choices = no-emit case).
- [x] **`verify-handoff-proof.sh s3-01` → `PROOF_OK`** (3 claims, 4 assertions) — first-try clean.
- [x] **`assertions_satisfied == assertions_required`** (`REQ-9`, both named tests, `cmd:typecheck_all`).
- [x] **Independent verification:** `bun run build` exit 0; interactive test 2 pass; core 374 pass; engagement 21 pass; `typecheck:all` green.
- [x] No `--no-verify`/suppression. Demo artifact `s3-01-tests.txt` **committed** (the S2-03 untracked-artifact issue did not recur — brief hardening worked). No stray root notes.

**Verdict:** `PROCEED`

## One-line summary
Additive `{type:'interactive'}` in the authoritative `stream.ts` union (voice.ts untouched); `ChoiceOption` relocated to core; collect/decide carry `choices?`, emitted on node entry · core 374 + eng 21 tests green, typecheck:all proves additive · proof `s3-01` · commit `01767de`.

## Notes
- The IC factored the node-entry emit into a dedicated `flow/emitInteractive.ts` helper (cleaner than inlining in `runFlow`) — good engineering, runFlow stays surgical.
- `prompt` source: confirm in the IC report which node text was used (best-effort display string; routing is by id so empty is acceptable). Not blocking.
