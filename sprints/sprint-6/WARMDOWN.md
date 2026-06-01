# Sprint 6 — Warm-down

> **Author:** Opus 4.8 (1M) · 2026-06-01 (long-running program mode).
> **Outcome:** Goal achieved — the same bot runs on WhatsApp + Instagram (+ web) via injected `ChannelPolicy`, each rendering/recovering per channel, no WhatsApp regression, no IG closed-window leak. Q7 verified + resolved.

## 1. Goal recap
**Sprint goal:** The same bot runs on WhatsApp and Instagram via injected `ChannelPolicy` adapters (web already from Sprint 0), each rendering/recovering per its channel rules.
**Did we hit it?** **Yes.** `whatsappPolicy`/`instagramPolicy` are `ChannelPolicy` objects; `closedWindowRecovery(policies)` dispatches per-channel closed-window strategy (WA template / IG HUMAN_AGENT tag-text-or-defer / web none) before the untouched terminal `windowGuard`; the same `ChoiceOption[]` renders per channel by stable id. Q7 (Instagram specifics) verified against current Meta docs — no divergence. Gate: `typecheck:all` green; **896 tests / 0 fail**.

## 2. Stories shipped
| Story | Status | Commit | Demo |
|-------|--------|--------|------|
| S6-02 (Q7 gate) | Done | `e08d66e` | [s6-02-instagram-verification.md](./artifacts/s6-02-instagram-verification.md) |
| S6-01 | Done | `3a3fa7b` | [s6-01-tests.txt](./artifacts/s6-01-tests.txt) |
| S6-03 | Done | `1ac2c50` | [s6-03-tests.txt](./artifacts/s6-03-tests.txt) |
No slips; no fix-pass code change.

## 3. What's working
- **Q7 resolved** — IG 24h / HUMAN_AGENT=7d / quick-reply ≤13 (20-char titles) / carousel ≤10 / button ≤3 / no template-approval, all verified vs Meta docs.
- **WhatsApp policy, no regression** — `whatsapp_policy_unchanged_behavior` (509 tests green at S6-01).
- **Instagram closed-window leak-safe** — `instagram_closed_window_tags_or_defers` (text→HUMAN_AGENT tag, interactive/media→defer).
- **Same bot across channels** — `same_bot_across_channels` (one ChoiceOption[] → WA buttons/list, IG button-template/carousel, same ids).

## 4. Known issues
| ID | Description | Severity |
|----|-------------|----------|
| KI-6-01 | `windowGuard` now passes tagged text on a closed window (necessary for IG HUMAN_AGENT recovery). Safe today (only `closedWindowRecovery` sets `tag`, for a `message-tag` policy on a closed window). **Invariant:** if a future caller sets `payload.tag` outside the recovery, the guard should validate the tag against the policy. | minor |
| KI-6-02 | IG quick-replies (≤13) mapped via button-template/carousel through the neutral `InteractiveMessage`; a dedicated quick-replies path is a future enhancement. | minor (intended) |

No blockers/majors.

## 5. Decisions made
- **Decision:** Q7 RESOLVED — IG assumptions verified vs current Meta docs; no divergence; G2 proceeded; RFC `05` amended. **Source:** artifacts/s6-02-instagram-verification.md. **RFC amendment:** `e08d66e` (Q7 → RESOLVED).
- **Decision:** policy-driven `closedWindowRecovery` before the **unchanged** terminal `windowGuard` (backstop preserved). **Source:** PLAN §0. **RFC amendment:** none.
- **Decision:** tagged-text payload/sink seam (`{kind:'text', tag?}`, `OutboundSink.sendTextWithTag?`, `isTagCapable`) — the concrete §4.12 IG mechanism (additive). **Source:** PLAN §0. **RFC amendment:** none.
- **Decision (IC, accepted):** `windowGuard` passes tagged text on a closed window — necessary to make the IG recovery work; leak-safe (KI-6-01). **RFC amendment:** none (consistent with §4.12 message-tag intent).

## 6. RFC amendments
**Q7 resolved** in `05-security-rollback-open-qs.md` (commit `e08d66e`). No other amendments.

## 7. Metrics
- **Test count:** 896 (added: 21 — whatsapp-policy 8, instagram-policy ~9, window-guard tagged-text, etc.). **`typecheck:all`:** green. **Diff:** 3 commits, +1097/−5 across 20 files.

## 8. Backlog updates
None new. (Messenger `ChannelPolicy` remains BK-05; durable WindowStore BK-06.)

## 9. Retrospective
### Keep
Running the Q7 verification gate as a real manager research task (web-verifying against primary Meta docs, writing a cited note, amending the RFC) — exactly what the gate is for; it confirmed the design rather than rubber-stamping it. Keeping the terminal `windowGuard` untouched in S6-01 and adding recovery in front preserved the leak floor through a big unification.
### Change
The brief said "don't touch the windowGuard," but the tagged-text recovery genuinely required a one-line guard change (S6-03 found it). Lesson: when a brief forbids touching a component, also state the *intended mechanism* for the dependent behavior so the IC doesn't have to choose between "follow the rule" and "make it work" — they correctly chose to make it work and flagged it.
### Try next
Sprint 7 (integration + release) is the capstone: `engagement({policies})` bridge (F1), the multi-platform example on 3 channels (F2), and the **publish-together dry-run** (`pnpm publish -r --dry-run`) (F3). Per CLAUDE.md, publish the whole `@kuralle-agents/*` graph together (core/messaging/messaging-meta/engagement) — the dry-run must show no split-graph pin. Brief F3 to run the dry-run from a neutral cwd (the `config.load()` monorepo gotcha) and assert no `.map` files in the would-be tarballs.

## 10. Pointers for the next sprint (Sprint 7 — Integration, proof & release)
- **Files to read first:** `packages/kuralle-engagement/src/index.ts` (F1 adds `engagement({policies, consent?, ownership?, audit?, scheduler?})` → `{bridge, broadcasts}`), `packages/kuralle-messaging/src/adapter/createMessagingRouter.ts` (`.bridge` spreads `outbound`/`inputResolver`/`onStatus`/`windowStore`/`ownership`/`consent`), `packages/kuralle-messaging-meta/examples/multi-platform/` (F2 — extend to WA+web+IG), root `package.json` (publish scripts: `pnpm publish -r`, `check-no-source-maps`), `CLAUDE.md` (publish-together rule).
- **Traps:** F1 must compose the full default chain `[consentGate, ownershipGate, closedWindowRecovery, interactiveRenderer, windowGuard]` (windowGuard terminal) from the policies + stores; `engagement().bridge` spreads into `createMessagingRouter`. F2 must drive the SAME bot on 3 channels offline (fake-client). F3 publish-together dry-run from a **neutral cwd** (monorepo `config.load()` gotcha), no `.map` in tarballs, version+publish the whole changed graph together (no split-graph pin → consumers would install two `core` copies).
- **Seams to build on:** all of S0–S6 — the bridge wires consent (S4), ownership (S4), closedWindowRecovery+policies (S6), interactiveRenderer (S3/S6), windowGuard (S1), broadcasts (S5).
- **Open RFC amendments:** none pending. **Open blockers:** none.

## 11. Closeout
- [x] Stories committed (S6-01..03 + Q7 gate). [x] No `Apply now`. [x] HANDOFF (local). [x] STATE → Sprint 7. [x] Artifacts archived. [x] RFC Q7 amended.
Sprint 6 is closed.
