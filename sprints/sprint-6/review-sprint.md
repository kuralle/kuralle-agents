# Sprint 6 — Manager Review (Phase B, sandwich, r1)

**Reviewer:** Opus 4.8 (1M) · 2026-06-01 · **Build branch:** `plan/whatsapp-engagement`
**Scope:** diff `b532ff2..1ac2c50` (3 commits — S6-02 research + S6-01 + S6-03; 20 files, +1097/−5), 2 impl briefs + 1 research note, 3 proceed-evidence, 2 proof JSONs + 1 research gate.
**Whole-sprint gate:** `typecheck:all` → exit 0; `bun test {core,messaging,messaging-meta,engagement}` → **896 pass / 0 fail / 104 files**.

## 1. Strengths
- **The Q7 gate was done properly, not hand-waved.** Instagram specifics were re-verified against current Meta docs (24h window, `HUMAN_AGENT`=7-day, quick-reply ≤13 + 20-char titles, carousel ≤10, button ≤3, no template approval) — all confirmed, no divergence, RFC Q7 marked RESOLVED (`05-...` amendment). The gate triggered no `/grill-me` because the assumptions held; the verified note is in `artifacts/s6-02-instagram-verification.md`.
- **The policy unification preserved the leak floor.** `whatsappPolicy`/`instagramPolicy` are `ChannelPolicy` objects; `closedWindowRecovery(policies)` dispatches per-channel (`template`→strategist, `message-tag`→tag-text-or-defer, `none`→defer) **before** the terminal `windowGuard`, which stays the non-removable backstop. S6-01 left the guard untouched; the full S1–S5 suite stayed green (509 → no WA regression).
- **`same_bot_across_channels` proven** — one `ChoiceOption[]` renders as WhatsApp buttons/list AND Instagram button-template/carousel with identical ids; inbound id-routing identical per policy. The omnichannel thesis (REQ-22) holds.
- **IG closed-window is leak-safe (IG-CW).** `instagram_closed_window_tags_or_defers` proves closed-window text ⇒ `sendTextWithTag(HUMAN_AGENT)` (sendText count 0); interactive/media ⇒ `deferred` (zero sends, no template attempted). Tag wraps text only.
- **IG renderer rejects over-limit** (>10 carousel, >20-char title) — R-11 extended to the IG channel.
- Both impl proofs clean first-try; the research gate produced a committed verified note; all artifacts committed.

## 2. Findings
**Blockers:** none. **Majors:** none.

**Minor:**
1. **`windowGuard` gained one line — `minor` (justified, necessary; the brief said don't touch it).** `if (req.payload.kind === 'text' && req.payload.tag) return next(req);`. The brief told S6-01 not to modify the guard, but S6-03 (the IC) correctly found the tagged-text seam is **incomplete without it**: tagging text in `closedWindowRecovery` is pointless if the terminal guard then defers it for `window.open===false`. A `HUMAN_AGENT`-tagged text is Meta's sanctioned out-of-window send, so the guard must pass it. **Verified not a leak:** the guard still defers untagged free-form (text/media/interactive); only `closedWindowRecovery` sets `tag`, and only for a `message-tag` policy on a closed window; an IG closed-window interactive/media still defers (tested). The IC added a `window-guard.test.ts` case covering the new pass-path. → **No action;** but the guard's safety now rests on the invariant **"only the recovery middleware sets `payload.tag`."** Recorded in WARMDOWN as KI-6-01 — if a future caller sets `tag` outside the recovery, revisit (e.g. validate the tag against the policy in the guard).
2. **Quick-replies (≤13) mapped via button-template/carousel — `minor` (intended).** The IG renderer uses the neutral `InteractiveMessage` (buttons→button-template ≤3, list→carousel ≤10) rather than a dedicated quick-replies (≤13) path. Faithful and within caps; quick-replies is a future enhancement (documented). → No action.

No `Apply now`.

## 3. Verdict
**READY — sprint closes.** No blockers/majors/Apply-now. Goal met: the same bot runs on WhatsApp + Instagram (+ web) via injected `ChannelPolicy`, each rendering/recovering per channel, with no WhatsApp regression and no IG closed-window leak. Q7 resolved (RFC amended). The one guard-relaxation is justified, necessary, leak-safe, and tested — recorded as KI-6-01 with its invariant. Public surfaces match RFC §4.12; the tagged-text payload/sink seam is the concrete §4.12 IG mechanism (additive). No fix-pass code change → warm-down.
