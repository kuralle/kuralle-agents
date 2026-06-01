# Story Brief — `S6-03` G2: Instagram ChannelPolicy

> **IC engineer (`cursor`, fresh process).** Self-contained. Ambiguity → **stop and ask**.
> **Atomic-commit:** `[S6-03] G2 Instagram ChannelPolicy` on **`plan/whatsapp-engagement`**. No push/`main`, one commit. **Bun.**

## 1. Goal
`instagramPolicy({client, windowStore})` → `ChannelPolicy`: 24h window; `closedWindow:{kind:'message-tag', tag:'HUMAN_AGENT'}` (text-only, else defer); `renderInteractive` → IG-appropriate `InteractiveMessage` (buttons→button-template ≤3, list→carousel ≤10; reject over-limit + over-length titles); `resolveInbound` → quick-reply/postback payload → id; `consentRequired:true`. The same flow runs on WhatsApp + Instagram. Proven by `instagram_closed_window_tags_or_defers`, `same_bot_across_channels`.

## 2. Required reading
1. `sprints/STATE.md`; `sprints/sprint-6/PLAN.md` § Story `S6-03` + § 0; **`sprints/sprint-6/artifacts/s6-02-instagram-verification.md`** (the verified IG specs — 24h, HUMAN_AGENT=7d, quick-reply ≤13 + 20-char titles, carousel ≤10, button ≤3).
2. RFC `02-...` **§4.12** (Instagram row — IG-CW: tag wraps text only), **REQ-22**; `03-...` **§6.1** (message-tag branch).
3. Source:
   - `packages/kuralle-engagement/src/policy.ts` — `ChannelPolicy`/`ClosedWindowStrategy`; `closed-window-recovery.ts` (S6-01 — the message-tag branch already routes text→tagged, else defer; **you do not re-implement recovery, you supply the IG policy it dispatches on**).
   - `packages/kuralle-engagement/src/policies/whatsapp.ts` (S6-01) — mirror the policy shape.
   - `packages/kuralle-messaging/src/types/outbound.ts` — the tagged-text seam (`{kind:'text', tag?}`, `OutboundSink.sendTextWithTag?`, `isTagCapable`) added in S6-01.
   - `packages/kuralle-messaging-meta/src/instagram/client.ts` — `sendTextWithTag(to, text, tag: InstagramMessageTag)` (~423), `sendInteractive` (~186, maps `InteractiveMessage` `buttons`→button-template ≤3, `list`→generic-template carousel), `sendQuickReplies` (~299), `sendButtonTemplate` (~346), `sendGenericTemplate` (~323). Inbound: postback `payload` → id (the client already normalizes button taps to `interactive`/`button`).
   - `packages/kuralle-messaging/src/types/messages.ts` — `InteractiveMessage` (`buttons|list|flow`).

> `bun run build` first (S6-01's tagged-text seam + whatsappPolicy in dist).

## 3. Specs
**`engagement/src/policies/instagram.ts` — `instagramPolicy`:**
```ts
export function instagramPolicy(opts: {
  client: InstagramClient;     // from @kuralle-agents/messaging-meta
  windowStore: WindowStore;
}): ChannelPolicy {
  return {
    channel: 'instagram',
    hasWindow: true,                                   // 24h
    async isWindowOpen(threadId) { return (await opts.windowStore.get(threadId)).open; },
    closedWindow: { kind: 'message-tag', tag: 'HUMAN_AGENT' },
    consentRequired: true,
    renderInteractive: (options, prompt) => renderInstagramInteractive(options, prompt),
    resolveInbound: (m) => resolveInboundInstagram(m),
  };
}
```
- **`renderInstagramInteractive(options, prompt): InteractiveMessage`** — verified caps (s6-02 note): ≤3 options → `{type:'buttons', body:prompt, action:{type:'buttons', buttons: options.map(id,label→{id,title})}}` (→ IG button-template via the client's `sendInteractive`); 4..10 → `{type:'list', ...}` (→ IG generic-template carousel); **>10 → throw**; any label/title **>20 chars → throw** (R-11, the IG title cap); NO WhatsApp Flows. (Quick-replies (≤13) is a valid alternative for the 4..13 case but maps via a non-`InteractiveMessage` path — for this cut, use button-template(≤3)/carousel(≤10) through the neutral `InteractiveMessage`; document that quick-replies is a future enhancement. Reject >10 either way.)
- **`resolveInboundInstagram(m): {input; selection?}`** — a quick-reply/postback tap arrives as `m.interactive?.id` or `m.button?.payload` (the IG client normalizes postbacks); map to `{input:id, selection:{id}}`; else text → `{input: m.text ?? ''}`. (Mirror the WhatsApp `resolveInbound` shape.)
- The **closed-window message-tag handling is already in `closedWindowRecovery` (S6-01)** — it sees `policy.closedWindow.kind==='message-tag'`, tags text (`{kind:'text', tag:'HUMAN_AGENT'}`) or defers interactive/media. You only supply the policy. Verify the IG client satisfies `isTagCapable` (it has `sendTextWithTag`); if the pipeline sink's `isTagCapable` check needs the IG client to expose `sendTextWithTag` with the `(to, text, tag)` signature, it already does (~423) — confirm the `tag` string `'HUMAN_AGENT'` is a valid `InstagramMessageTag`.

**Modify** `engagement/src/index.ts` — export `instagramPolicy`, `renderInstagramInteractive`.
**Create** `engagement/test/instagram-policy.test.ts`.

## 4. Acceptance criteria
1. `instagramPolicy(...)` per §3 (24h window, `closedWindow:{message-tag, HUMAN_AGENT}`, consentRequired true, IG renderer, postback→id inbound).
2. **`instagram_closed_window_tags_or_defers`**: with `closedWindowRecovery([igPolicy])` + `windowGuard` + an IG sink, a closed-window **text** ⇒ sink `sendTextWithTag(..., 'HUMAN_AGENT')` called (tagged, not free-form); a closed-window **interactive/media** ⇒ `deferred` (zero send; no WhatsApp-style template attempted).
3. IG renderer: ≤3→buttons (button-template), 4..10→list (carousel), >10→throws, >20-char title→throws. No Flows.
4. **`same_bot_across_channels`**: the same `ChoiceOption[]` → WhatsApp `renderChoices` (buttons/list) AND `renderInstagramInteractive` (buttons/carousel) with the SAME ids; an inbound id (button/postback) routes identically via each policy's `resolveInbound`. No bot-code change.
5. `bun run build` + `typecheck:all` green; **`whatsapp_policy_unchanged_behavior` still green** (no WA regression); full suite green.

## 5. What NOT to do
- Don't re-implement `closedWindowRecovery` (S6-01) — supply the IG policy it dispatches on.
- Don't tag interactive/media (IG-CW — text only, else defer).
- Don't add WhatsApp list/Flows to IG. Don't silently slice over-limit (throw).
- No `any`/`@ts-ignore`/`--no-verify`/silent catch.

## 6. Validation contract (`.handoff/proof-s6-03.json`)
`assertions_required`: `REQ-22`, `test:instagram_closed_window_tags_or_defers`, `test:same_bot_across_channels`, `cmd:typecheck_all`.

| claim_id | command | satisfies_assertions |
|----------|---------|----------------------|
| ig-policy-test | `bun test packages/kuralle-engagement/test/instagram-policy.test.ts` | REQ-22, test:instagram_closed_window_tags_or_defers, test:same_bot_across_channels |
| full-suite | `bun test packages/kuralle-messaging packages/kuralle-messaging-meta packages/kuralle-engagement` | REQ-22 (no WA regression) |
| typecheck | `bun run typecheck:all` | cmd:typecheck_all |

### PROOF SCHEMA CHEAT-SHEET (follow exactly)
- `claims[].type` ∈ **`test_suite`|`typecheck`|`lint`|`http`|`custom_command`|`ui_recording`|`file_exists`** only.
- Each claim: **`id`** (NOT `claim_id`) = sidecar basename (`.handoff/proof-s6-03-<id>.stdout`) + `stdout_sidecar`, `command`, `cwd`, `exit_code`, `stdout_sha256`, `satisfies_assertions`.
- `commands_run[]` `purpose`=`"verification"`; `claim_id` matches a `claims[].id`. `assertions_satisfied`==`assertions_required`. Sentinel `echo "DONE $(git rev-parse HEAD) proof=.handoff/proof-s6-03.json" > .handoff/result-s6-03.done`.

## 7. Demo artifact
`sprints/sprint-6/artifacts/s6-03-tests.txt` — named tests + full-suite tail. **`git add` it.**

## 8. Report back
Files, commit sha, proof slug `s6-03`, DoD, demo, trade-offs (esp. the quick-replies-vs-carousel mapping choice + confirming `'HUMAN_AGENT'` is a valid `InstagramMessageTag`). **No `*-implementation-notes.md`.** No PR.

## 9. If stuck
- If `InstagramMessageTag` doesn't include `'HUMAN_AGENT'`, check the IG client's tag type; flag if the tag isn't supported.
- If the IG client's `sendInteractive` can't render the neutral `InteractiveMessage` you produce, adapt the renderer to what it accepts; flag if a needed send shape is missing.
- Baseline green pre-story. No shortcuts; no WA regression.
