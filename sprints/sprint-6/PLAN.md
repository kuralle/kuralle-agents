# Sprint 6 — Plan

**Sprint name:** Channel adapters
**Sprint goal (one sentence):** The same bot runs on WhatsApp and Instagram via injected `ChannelPolicy` adapters (web already from Sprint 0), each rendering/recovering per its channel rules.
**Sprint window:** 2026-06-01 → 2026-06-08
**Author (main session):** Opus 4.8 (1M) · 2026-06-01

---

## 0. Decisions made before briefing (read first)

- **S6-02 (Q7) is DONE** — verified, no divergence (commit `e08d66e`; note `artifacts/s6-02-instagram-verification.md`). G2 proceeds with two enrichments: `HUMAN_AGENT` tag duration = 7 days; quick-reply title cap = 20 chars (renderer rejects over-length, no silent slice — R-11). Stories left: **S6-01 (WhatsApp policy)**, **S6-03 (Instagram policy)**.
- **Policy-driven closed-window recovery WITHOUT refactoring the terminal `windowGuard`.** The Sprint-1 `windowGuard` stays the non-removable terminal backstop (defers any free-form on a closed window). Sprint 6 adds a `closedWindowRecovery(policies)` `OutboundMiddleware` (engagement), installed **before** `windowGuard`, that generalizes the Sprint-2 `strategistMiddleware` to dispatch on the matched policy's `closedWindow`:
  - look up `policyFor(req.platform)`; if no policy, or `!policy.hasWindow`, or `await policy.isWindowOpen(threadId)` → `next(req)` (open / no-window → pass).
  - closed window → `switch (policy.closedWindow.kind)`:
    - `'template'` (WhatsApp): `strategist.decide({text, window})` → `template`⇒`next({...req, payload:template})`; `defer`⇒`{deferred}`; `freeform`⇒`next(req)` (guard will defer if still closed).
    - `'message-tag'` (Instagram): if `req.payload.kind==='text'` → `next({...req, payload:{kind:'text', text, tag: policy.closedWindow.tag}})` (tagged text — see below); else `{deferred, reason:'window-closed-tag-text-only'}` (interactive/media can't be tagged — IG-CW).
    - `'none'` (web): `{deferred, reason:'window-closed-no-recovery'}` (web never hits this — always open).
  This keeps `strategistMiddleware` (S2) working for the explicit `smartSend` node path; `closedWindowRecovery` is the policy-aware automatic path. (Both share the same strategist instance when constructed from the same policy.)
- **Tagged-text mechanism (additive, the concrete §4.12 IG mechanism).** `OutboundPayload`'s `{kind:'text'}` gains an optional `tag?: string`. `OutboundSink` gains an optional `sendTextWithTag?(to, text, tag): Promise<SendResult>` + an `isTagCapable(sink)` guard (mirrors `sendTemplate?`/`isTemplateCapable`). The pipeline **sink terminal**: for `{kind:'text'}` with a `tag` and an `isTagCapable` sink → `sendTextWithTag`; else `sendText`. The Instagram client satisfies `sendTextWithTag` (wraps `instagram/client.ts` `sendTextWithTag` ~423). This keeps the tagged send **inside the pipeline** (no client bypass). Additive — existing text sends (no tag) are unchanged.
- **Renderer + inbound become policy-aware.** A policy-driven `interactiveRenderer(policies)` calls `policyFor(req.platform).renderInteractive(options, prompt)`; a policy-driven inbound uses `policyFor(platform).resolveInbound(message)`. To avoid regressing S3's WhatsApp behavior, `whatsappPolicy.renderInteractive` = the S3 `renderChoices`, and `whatsappPolicy.resolveInbound` = the S3 `InteractiveResolver`/`TextResolver` logic. (S3's standalone `interactiveRenderer()`/`InboundResolverChain` remain for the default/no-policy path; the policy versions are used when policies are injected.)
- **Policy registry:** a `Map<string, ChannelPolicy>` keyed by `policy.channel`, built from the injected `policies[]`. `policyFor(platform)` looks up by the platform name (e.g. `'whatsapp'`, `'instagram'`, `'web'`). For Sprint 6, the policies are injected directly into the middleware/test; the `engagement({policies})` bridge that wires them into `createMessagingRouter` is **Sprint 7 (F1)**.
- **No WhatsApp regression** — `whatsapp_policy_unchanged_behavior`: the WhatsApp policy reproduces S1–S3 behavior (window block/template recovery/interactive render/inbound id-routing). Run the full suite.

---

## 1. Stories

### `S6-01` — G1: WhatsApp `ChannelPolicy` + policy-driven recovery/render/inbound
**Description:** `whatsappPolicy({client, selector, windowStore, wabaId, audit?})` → `ChannelPolicy`. Add `closedWindowRecovery(policies)` middleware (policy-dispatched closed-window recovery), `interactiveRenderer(policies)` (policy-dispatched render), and a policy-driven inbound resolution path. Add the tagged-text payload/sink seam (so S6-03 can use it). Prove the WhatsApp path is unchanged.
**Acceptance criteria:**
1. `whatsappPolicy(...)` returns a `ChannelPolicy`: `channel:'whatsapp'`, `hasWindow:true`, `isWindowOpen`←`windowStore.get`, `closedWindow:{kind:'template', strategist}` (strategist from `whatsappTemplateCatalog`+selector+audit), `consentRequired:true`, `renderInteractive`=`renderChoices` (S3), `resolveInbound`=interactive-then-text (S3).
2. `closedWindowRecovery(policies): OutboundMiddleware` per §0 (template branch for WhatsApp). Installed before the terminal `windowGuard`.
3. Tagged-text seam: `OutboundPayload {kind:'text'}` gains `tag?`; `OutboundSink.sendTextWithTag?` + `isTagCapable`; pipeline sink uses `sendTextWithTag` for tagged text when capable. (WhatsApp doesn't use tags — this seam is for S6-03; add it here so the sink is ready.)
4. `whatsapp_policy_unchanged_behavior`: with a `whatsappPolicy` + `closedWindowRecovery([waPolicy])` + `windowGuard`, a closed-window text → template (via strategist) reaches the sink; open-window text sends; over-limit interactive render rejects; inbound button routes by id. (No regression vs S1–S3.)
5. `bun run build` + `typecheck:all` green; full suite green.
**Files:** `engagement/src/{policies/whatsapp.ts, closed-window-recovery.ts, interactive-renderer.ts (policy-aware variant)}`, `engagement/src/index.ts`; `messaging/src/types/outbound.ts` (text `tag?`, `OutboundSink.sendTextWithTag?`, `isTagCapable`) + `outbound-pipeline.ts` (sink tagged-text) + index; tests.

### `S6-03` — G2: Instagram `ChannelPolicy`
**Description:** `instagramPolicy({client, windowStore})` → `ChannelPolicy`: 24h window; `closedWindow:{kind:'message-tag', tag:'HUMAN_AGENT'}` (text-only, else defer); `renderInteractive` → quick-replies(≤13, titles ≤20 chars)/button-template(≤3)/generic-template carousel(≤10) — reject over-limit; `resolveInbound` → quick-reply/postback payload → id; `consentRequired:true`. Instagram client satisfies `sendTextWithTag` (the tagged-text sink). The same flow runs on WA + IG.
**Acceptance criteria:**
1. `instagramPolicy(...)` per §0/§4.12; `channel:'instagram'`, `hasWindow:true`, `closedWindow:{kind:'message-tag', tag:'HUMAN_AGENT'}`.
2. `instagram_closed_window_tags_or_defers`: closed window + text ⇒ tagged text reaches the sink (`sendTextWithTag` with `HUMAN_AGENT`); closed window + interactive/media ⇒ `deferred` (never free-form leak; no WhatsApp-style template attempted).
3. IG renderer: ≤3→button-template, ≤13→quick-replies, carousel→generic-template(≤10); over-limit (>13 quick-replies, >10 carousel, >20-char title) ⇒ explicit error (no silent slice). No WhatsApp list/Flows.
4. IG inbound: quick-reply/postback payload → `{input:id, selection:{id}}`.
5. `same_bot_across_channels` (partial — WA + IG here; web already): the same `ChoiceOption[]` renders per channel (WA buttons/list vs IG quick-replies/carousel) with no bot-code change; inbound id-routing identical.
6. `bun run build` + `typecheck:all` green; full suite green; **`whatsapp_policy_unchanged_behavior` still green** (no WA regression from adding IG).
**Files:** `engagement/src/policies/instagram.ts` (or `messaging-meta/src/instagram/policy.ts` per RFC — keep policy in engagement for consistency, importing the IG client from messaging-meta), `engagement/src/index.ts`; `messaging-meta/src/instagram/client.ts` (confirm/extend `sendTextWithTag`/quick-reply/template send shapes if missing); tests.

---

## 2. Universal DoD
Tests happy+failure offline; `bun run build` + `typecheck:all` green; surfaces match RFC §4.12; **no WhatsApp-path regression** (`whatsapp_policy_unchanged_behavior`); IG renderer rejects over-limit (R-11, incl. 20-char quick-reply titles); tagged-text stays in the pipeline (no client bypass); no `--no-verify`/suppression/silent-catch; atomic `[S6-{nn}]` commit + proof JSON; commit demo artifacts; no stray `*-implementation-notes.md`. Proof-schema cheat-sheet in every brief.

## 3. Test plan
| Story | Named tests |
|-------|-------------|
| S6-01 | `whatsapp_policy_unchanged_behavior` (+ tagged-text sink unit) |
| S6-03 | `instagram_closed_window_tags_or_defers`, `same_bot_across_channels` (WA+IG render-by-id), IG renderer over-limit |

**Not tested (safe):** live Meta IG/WA sends (offline fake-client); the `engagement({policies})` bridge wiring (Sprint 7 F1); Messenger (deferred, BK-05); the full 3-channel example (Sprint 7 F2).

## 4. Demo plan
Offline: the same flow's `ChoiceOption[]` renders as WhatsApp buttons/list AND Instagram quick-replies/carousel (no bot change); a closed-window IG text is tagged `HUMAN_AGENT`, a closed-window IG interactive defers; the WhatsApp path is unchanged.

## 5. Risks
| Risk | Detection | Mitigation |
|------|-----------|------------|
| Policy unification regresses the WhatsApp path | S1–S3 WA tests fail | keep the terminal `windowGuard` backstop unchanged; `whatsapp_policy_unchanged_behavior`; run full suite. |
| IG message-tag bypasses the pipeline (client called directly) | a free-form/tagged send not through the pipeline | tagged-text via the additive `{kind:'text', tag}` payload + `sendTextWithTag?` sink — stays in the pipeline. |
| IG interactive/media tagged (invalid) | a leak of untaggable payload | message-tag branch handles `kind:'text'` only, else `deferred` (IG-CW); test it. |
| IG renderer silently slices >13 quick-replies / >20-char titles | dropped options | explicit error (R-11); test over-limit. |

## 6. Open questions
None blocking. The tagged-text payload/sink extension (§0) is the concrete mechanism RFC §4.12 implies (IG `sendTextWithTag`) — additive, not a divergence. If the IG client's `sendTextWithTag`/quick-reply/template method signatures differ from the RFC's line refs, the IC adapts the policy to the real signatures and flags only if a needed send shape is entirely missing.
