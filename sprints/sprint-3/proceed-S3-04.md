# Proceed Evidence — `S3-04` C4: withChoices + interactive end-to-end

> **Manager artifact — Phase A only.** Phase A complete after this.

## Story
- **Id:** `S3-04` · **Commit:** `9a92305` · **Slug:** `s3-04` · **Worker:** cursor.

## Proceed checklist (manager — read diff, did not trust IC chat)
- [x] **Diff read** — `engagement/src/authoring.ts` (`withChoices`), `engagement/src/index.ts`, `core/src/index.ts` (+export `CollectNode`/`DecideNode` — additive, brief-allowed), `test/interactive-e2e.test.ts`. Scope matches brief.
- [x] **`withChoices` correct** — `{...node, choices}`, preserves kind (`decide`/`collect`) + id; typed to `CollectNode|DecideNode`.
- [x] **E2E is behavioral** — drives a real flow (asserts `{type:'interactive'}` part emitted on node entry, S3-01), pipes parts through a **real** `OutboundPipeline([interactiveRenderer(), windowGuard], sink)` (S3-02) and asserts the sink's `sendInteractive` receives 3 buttons, and resolves an inbound `button_reply{id, title}` by id + a `formResponse`→formData (S3-03). Composes all three prior seams; not shape-only.
- [x] **`verify-handoff-proof.sh s3-04` → `PROOF_OK`** (3 claims, 5 assertions) — first-try clean.
- [x] **`assertions_satisfied == assertions_required`** (`REQ-7`, `REQ-8`, `test:withchoices_attaches`, `test:interactive_end_to_end`, `cmd:typecheck_all`).
- [x] **Independent verification:** `bun run build` exit 0; e2e test **3 pass / 0 fail**; whole-sprint `typecheck:all` green; `bun test {core,messaging,messaging-meta,engagement}` → **853 pass / 0 fail**.
- [x] No `--no-verify`/suppression. Demo artifact committed. No stray root notes.

**Verdict:** `PROCEED` — **Phase A complete (all 4 stories `PROCEED`).**

## One-line summary
`withChoices` attaches choices to collect/decide; e2e proves emit → render(3 buttons) → route-by-id (label-independent) → formData, composing S3-01..03 · 853 tests green · proof `s3-04` · commit `9a92305`.
