# Proceed Evidence — `S6-01` G1: WhatsApp ChannelPolicy + policy-driven recovery

> **Manager artifact — Phase A only.**

## Story
- **Id:** `S6-01` · **Commit:** `3a3fa7b` · **Slug:** `s6-01` · **Worker:** cursor.

## Proceed checklist (manager — read diff, did not trust IC chat)
- [x] **Diff read** — `engagement/src/{policies/whatsapp.ts, closed-window-recovery.ts, resolve-inbound-whatsapp.ts, interactive-renderer.ts (policy-aware), index.ts}`; `messaging/src/types/outbound.ts` (tagged-text seam), `outbound-pipeline.ts` (sink uses `sendTextWithTag` when `payload.tag && isTagCapable`), index. Scope matches brief.
- [x] **Terminal `windowGuard` UNTOUCHED** — `git show` of `middleware/window-guard.ts` = 0 diff lines. The non-removable backstop is intact; `closedWindowRecovery` sits **before** it. This is the key safety check for the unification.
- [x] **Tagged-text seam correct + additive** — `{kind:'text', tag?}` + `OutboundSink.sendTextWithTag?` + `isTagCapable`; pipeline sink: `if (payload.tag && isTagCapable(sink)) sendTextWithTag else sendText`. Untagged text unchanged.
- [x] **`closedWindowRecovery([waPolicy])`** dispatches `policy.closedWindow`: template→strategist (text→template or defer); non-text→passes to the guard; (message-tag/none branches ready for S6-03/web).
- [x] **`verify-handoff-proof.sh s6-01` → `PROOF_OK`** (3 claims, 3 assertions) — first-try clean.
- [x] **`assertions_satisfied == assertions_required`** (`REQ-22`, `test:whatsapp_policy_unchanged_behavior`, `cmd:typecheck_all`).
- [x] **Independent verification (the no-regression check):** `bun run build` exit 0; `bun test packages/kuralle-messaging packages/kuralle-messaging-meta packages/kuralle-engagement` → **509 pass / 0 fail** (S1/S2/S3 WhatsApp tests all still pass — the policy unification did NOT regress the WA path); `whatsapp-policy.test.ts` 8 tests incl. `whatsapp_policy_unchanged_behavior`; `typecheck:all` green.
- [x] No `--no-verify`/suppression. Demo artifact committed. No stray notes.

**Verdict:** `PROCEED`

## One-line summary
`whatsappPolicy` + policy-dispatched `closedWindowRecovery` (before the untouched terminal `windowGuard`) + additive tagged-text sink seam; WhatsApp path unchanged (509 tests green) · proof `s6-01` · commit `3a3fa7b`.

## Notes
- The terminal `windowGuard` backstop is preserved verbatim — the recovery layer is purely additive in front of it. This is exactly the design that keeps the leak guarantee while adding per-channel recovery.
- Tagged-text seam is in place for S6-03 (IG `HUMAN_AGENT`); WhatsApp doesn't use it.
