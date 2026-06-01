# Proceed Evidence — `S6-03` G2: Instagram ChannelPolicy

> **Manager artifact — Phase A only.** Phase A complete after this (S6-01 + S6-02 + S6-03).

## Story
- **Id:** `S6-03` · **Commit:** `1ac2c50` · **Slug:** `s6-03` · **Worker:** cursor.

## Proceed checklist (manager — read diff, did not trust IC chat)
- [x] **Diff read** — `engagement/src/{policies/instagram.ts, render-instagram-interactive.ts, resolve-inbound-instagram.ts, index.ts}`, `messaging-meta/src/instagram/client.ts` (+`button: msg.button` on IG inbound — additive, mirrors S0-02), `messaging/src/adapter/middleware/window-guard.ts` (+1 line — see Notes), test. Scope matches brief + a necessary guard fix.
- [x] **`instagramPolicy`** per §4.12 — 24h window, `closedWindow:{kind:'message-tag', tag:'HUMAN_AGENT'}`, `consentRequired:true`, IG renderer, postback→id inbound.
- [x] **`instagram_closed_window_tags_or_defers` is behaviorally rigorous** — closed-window text ⇒ outcome `sent` via `sendTextWithTag(..., 'HUMAN_AGENT')` with `sendText` count **0** (tagged, not free-form); closed-window interactive ⇒ `{deferred, reason:'window-closed-tag-text-only'}`, `sendInteractive`/`sendTextWithTag` count **0**; media likewise. **No free-form leak; no WhatsApp template attempted.**
- [x] **`same_bot_across_channels`** — same `ChoiceOption[]` renders on WhatsApp (buttons/list) and Instagram (button-template/carousel) with identical ids; inbound id routes identically per policy.
- [x] **`verify-handoff-proof.sh s6-03` → `PROOF_OK`** (3 claims, 4 assertions) — first-try clean.
- [x] **Independent verification:** `bun run build` exit 0; whole-sprint `bun test {core,messaging,messaging-meta,engagement}` → **896 pass / 0 fail**; `whatsapp_policy_unchanged_behavior` still green (no WA regression from adding IG); `typecheck:all` green.
- [x] No `--no-verify`/suppression. Demo artifact committed. No stray notes.

**Verdict:** `PROCEED` — **Phase A complete.**

## One-line summary
`instagramPolicy` (24h window, HUMAN_AGENT tag text-only-else-defer, button-template/carousel render, postback→id) — same bot renders/recovers per channel · 896 tests green · proof `s6-03` · commit `1ac2c50`.

## Notes
- **Window-guard change (justified, necessary — flag for the review):** S6-03 added one line to the terminal `windowGuard`: `if (req.payload.kind === 'text' && req.payload.tag) return next(req);`. The brief said don't modify the guard, but the IC correctly found that the S6-01 tagged-text seam is **incomplete without it** — tagging text in `closedWindowRecovery` is pointless if the terminal guard then defers it for `window.open === false`. A `HUMAN_AGENT`-tagged text is Meta's sanctioned out-of-window send (7-day window), so the guard MUST pass it. **This is NOT a leak:** the guard still defers untagged free-form (text/media/interactive), and only `closedWindowRecovery` (which checked the policy + closed window) sets `tag`. The leak guarantee holds; the relaxation is principled (tagged = authorized). Review note: document the invariant "only the recovery middleware sets `payload.tag`, and only for a `message-tag` policy on a closed window."
