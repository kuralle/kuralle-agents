# Proceed Evidence — `S0-01` Scaffold `@kuralle-agents/engagement`

> **Manager artifact — Phase A only.** Confirms this story may proceed to the next. Not a gate-worker review.

---

## Story

- **Id:** `S0-01`
- **Commit:** `2dffb53` — `[S0-01] Scaffold @kuralle-agents/engagement`
- **IC slug:** `s0-01` (`.handoff/brief-s0-01.md` / `sprints/sprint-0/brief-s0-01.md`)
- **Worker:** cursor (`--model auto`)

---

## Proceed checklist (manager — read diff, did not trust IC chat)

- [x] **Diff read** — scope matches brief §3 exactly: `packages/kuralle-engagement/{package.json,tsconfig.json,src/index.ts,README.md}`, `scripts/build-packages.sh` (T3 + `engagement`), `bun.lock`, `sprints/sprint-0/artifacts/s0-01-build.txt`. No out-of-scope edits; no `core`/`messaging` touched; proof artifacts not committed.
- [x] **Package contents verified against spec** — `@kuralle-agents/engagement`, ESM/NodeNext, exports map, `core`-only dep, `sourceMap:false`, near-empty `src/index.ts`.
- [x] **`.handoff/proof-s0-01.json` exists** + 5 stdout sidecars.
- [x] **`verify-handoff-proof.sh s0-01` → `PROOF_OK`** (5 claims verified, 5 assertions satisfied) — *after manager corrected proof claim-type enums (see Notes).*
- [x] **`validation_contract.assertions_satisfied == assertions_required`** (`cmd:build`, `cmd:typecheck_all`, `file:dist_js`, `file:dist_dts`, `cmd:no_source_maps`).
- [x] **Independent manager verification (empirical, not sidecar-trust):** `rm -rf dist && bun run build` → exit 0; `engagement` builds in T3; `dist/index.js` + `dist/index.d.ts` present; `find dist -name '*.map'` empty. Baseline `typecheck:all` was green pre-story and the IC's sweep (58 configs) is green with the package; `bun run build` re-compiles engagement's tsc clean.
- [x] **No `--no-verify` / type-suppression** in diff.
- [x] **Demo artifact** `sprints/sprint-0/artifacts/s0-01-build.txt` exists.

**Verdict:** `PROCEED`

---

## One-line summary

`@kuralle-agents/engagement` scaffolded into the Bun workspace + T3 build tier; build + typecheck:all green, no source maps · proof `s0-01` · commit `2dffb53`.

---

## Notes

- **Proof-format correction (manager, not a substantive defect):** the IC's proof used three invalid `claims[].type` enum values — `"build"` and `"shell"` and two `file_exists` claims modeled as `test -f` commands. The schema (`delegate-proof-schema.md`) only allows `test_suite|typecheck|lint|http|custom_command|ui_recording|file_exists`. I normalized all three to `custom_command` (they each ran a real shell command with a matching sidecar + sha256). The commands, sidecars, and sha256 hashes were untouched, and I independently re-ran `bun run build` to confirm the substance before accepting. This is a proof-encoding fix, not a re-run of failed work.
- **Lockfile name:** repo uses `bun.lock` (not `bun.lockb`); the brief's `bun.lockb` reference was stale — IC committed `bun.lock` correctly.
- **Forward trap for S0-04:** `engagement` currently depends on `core` only. S0-04 adds `@kuralle-agents/messaging` (`workspace:*`) when the `ChannelPolicy` seam imports `InboundMessage`/`InteractiveMessage`. No action now.
- **Brief refinement for future stories:** add the valid claim-type enum list to briefs' proof section so ICs don't invent `type` values. (Applied implicitly going forward.)
