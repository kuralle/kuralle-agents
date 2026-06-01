# Proceed Evidence — `S3-02` C2: interactiveRenderer middleware + limits

> **Manager artifact — Phase A only.**

## Story
- **Id:** `S3-02` · **Commit:** `cb321b1` · **Slug:** `s3-02` · **Worker:** cursor.

## Proceed checklist (manager — read diff, did not trust IC chat)
- [x] **Diff read** — `engagement/src/interactive-renderer.ts` (new: `renderChoices` + `interactiveRenderer` middleware), `index.ts`, test. No stream/resolver/withChoices/WA-client edits.
- [x] **R-11 enforced (no silent slice)** — `renderChoices` throws on: empty options, flow w/ >1 option or missing cta, >`BUTTON_COUNT_MAX` url/buttons, >`LIST_ROW_COUNT_MAX` (10) list rows, over-length labels (`assertButtonTitle`). Explicit `Error`s citing the limit — never truncates.
- [x] **Routing by size** — ≤3 ⇒ buttons; 4..10 ⇒ list; `flow` ⇒ Flow; `url` ⇒ buttons/cta. Middleware consumes the `{type:'interactive'}` part from `req.meta.parts` and rewrites payload to `{kind:'interactive', interactive}`; passes through when no part.
- [x] **`verify-handoff-proof.sh s3-02` → `PROOF_OK`** (3 claims, 4 assertions) — first-try clean.
- [x] **`assertions_satisfied == assertions_required`** (`REQ-7`, `test:render_picks_buttons_then_list`, `test:renderer_rejects_over_limit`, `cmd:typecheck_all`).
- [x] **Independent verification:** `bun run build` exit 0; renderer test **11 pass / 0 fail** (both named tests present); `bun test packages/kuralle-engagement` → **32 pass / 0 fail**; `typecheck:all` green.
- [x] No `--no-verify`/suppression. Demo artifact committed. No stray root notes.

**Verdict:** `PROCEED`

## One-line summary
`interactiveRenderer` middleware renders `ChoiceOption[]`→buttons(≤3)/list(≤10)/cta/Flow and **throws** on over-limit (no silent slice, R-11) · 32 engagement tests green · proof `s3-02` · commit `cb321b1`.

## Notes
- The renderer is installed before the terminal `windowGuard` (like `strategistMiddleware`); the rendered `{kind:'interactive'}` payload still traverses the window-safe pipeline.
- cta/url options mapped to a buttons action (the `InteractiveMessage` union has no dedicated cta shape) — documented IC choice; fine for v1.
