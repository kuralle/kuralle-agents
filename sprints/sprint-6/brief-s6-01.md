# Story Brief — `S6-01` G1: WhatsApp ChannelPolicy + policy-driven recovery/render

> **IC engineer (`cursor`, fresh process).** Self-contained. Ambiguity → **stop and ask**.
> **Atomic-commit:** `[S6-01] G1 WhatsApp ChannelPolicy + policy-driven recovery` on **`plan/whatsapp-engagement`**. No push/`main`, one commit. **Bun.**

## 1. Goal
`whatsappPolicy(...)` → `ChannelPolicy`; a policy-dispatched `closedWindowRecovery(policies)` middleware (generalizes the S2 strategist to per-channel `closedWindow`); the tagged-text payload/sink seam (for S6-03 IG). The WhatsApp path is unchanged (`whatsapp_policy_unchanged_behavior`). Terminal `windowGuard` stays the backstop.

## 2. Required reading
1. `sprints/STATE.md`; `sprints/sprint-6/PLAN.md` § Story `S6-01` + § 0 (esp. the recovery-before-terminal-guard design + tagged-text seam).
2. RFC `02-...` **§4.12** (ChannelPolicy/ClosedWindowStrategy, WhatsApp row), **§4.2** (OutboundSink/capability), **REQ-22**; `03-...` **§6.1** (windowGuard via policy.closedWindow).
3. Source:
   - `packages/kuralle-engagement/src/policy.ts` — `ChannelPolicy`/`ClosedWindowStrategy` (S0-04), `ChoiceOption`.
   - `packages/kuralle-engagement/src/{strategist.ts, strategist-middleware.ts, catalog.ts, selector.ts, interactive-renderer.ts (renderChoices)}` (S2/S3) — reuse these in the WhatsApp policy.
   - `packages/kuralle-messaging/src/adapter/{window-store.ts, middleware/window-guard.ts, outbound-pipeline.ts}` (S1) — windowGuard stays terminal; the recovery middleware sits before it.
   - `packages/kuralle-messaging/src/types/outbound.ts` — `OutboundPayload`/`OutboundSink`/`isTemplateCapable`/`OutboundMiddleware` (extend per §3).
   - `packages/kuralle-messaging/src/adapter/input-resolver-chain.ts` (S3) — `InteractiveResolver`/`TextResolver` for the WhatsApp policy's `resolveInbound`.
   - WhatsApp client: `sendInteractive` (maps InteractiveMessage), `sendTemplate`.

> `bun run build` first.

## 3. Specs
**Tagged-text seam — `messaging/src/types/outbound.ts`:**
- `OutboundPayload` `{kind:'text'}` variant gains optional `tag?: string`: `{ kind:'text'; text:string; tag?:string }`.
- `OutboundSink` gains optional `sendTextWithTag?(to: string, text: string, tag: string): Promise<SendResult>`.
- Add `isTagCapable(c): c is … & Required<Pick<OutboundSink,'sendTextWithTag'>>` (mirror `isTemplateCapable`).
**`outbound-pipeline.ts` terminal:** for `{kind:'text'}`: if `payload.tag && isTagCapable(sink)` → `sink.sendTextWithTag(threadId, text, payload.tag)`; else `sink.sendText(threadId, text)`. (Additive — untagged text unchanged.)

**`engagement/src/policies/whatsapp.ts` — `whatsappPolicy`:**
```ts
export function whatsappPolicy(opts: {
  client: WhatsAppClient;            // from @kuralle-agents/messaging-meta
  selector: TemplateSelector;
  windowStore: WindowStore;          // from @kuralle-agents/messaging
  wabaId: string;
  audit?: AuditSink;
}): ChannelPolicy {
  const catalog = whatsappTemplateCatalog({ client: opts.client, wabaId: opts.wabaId });
  const strategist = createSmartSendStrategist({ catalog, selector: opts.selector, audit: opts.audit ?? { record() {} } });
  return {
    channel: 'whatsapp',
    hasWindow: true,
    async isWindowOpen(threadId) { return (await opts.windowStore.get(threadId)).open; },
    closedWindow: { kind: 'template', strategist },
    consentRequired: true,
    renderInteractive: (options, prompt) => renderChoices(options, prompt),     // S3
    resolveInbound: (m) => resolveInboundWhatsApp(m),                            // S3 interactive-then-text, sync wrapper
  };
}
```
(`resolveInbound` is sync per the `ChannelPolicy` interface — wrap the S3 resolver logic synchronously: interactive.id / button.payload / formResponse / text. Reuse the S3 `InteractiveResolver`/`TextResolver` logic; if they're async, inline the sync mapping.)

**`engagement/src/closed-window-recovery.ts` — `closedWindowRecovery(policies: ChannelPolicy[]): OutboundMiddleware`:**
```ts
const byChannel = new Map(policies.map(p => [p.channel, p]));
return {
  name: 'closed-window-recovery',
  async send(req, next) {
    const policy = byChannel.get(req.platform);
    if (!policy || !policy.hasWindow || (await policy.isWindowOpen(req.threadId))) return next(req);
    const cw = policy.closedWindow;
    if (cw.kind === 'template') {
      if (req.payload.kind !== 'text') return next(req);   // non-text → let the terminal guard defer it
      const d = await cw.strategist.decide({ text: req.payload.text, window: req.meta.window });
      if (d.kind === 'template') return next({ ...req, payload: { kind: 'template', template: d.template } });
      if (d.kind === 'defer') return { kind: 'deferred', reason: d.reason };
      return next(req);   // freeform → guard defers if still closed
    }
    if (cw.kind === 'message-tag') {
      if (req.payload.kind === 'text') return next({ ...req, payload: { ...req.payload, tag: cw.tag } });
      return { kind: 'deferred', reason: 'window-closed-tag-text-only' };
    }
    return { kind: 'deferred', reason: 'window-closed-no-recovery' };   // 'none'
  },
};
```
Installed before the terminal `windowGuard`. (Note: `isWindowOpen` here may double-read the store vs the guard's `meta.window`; that's fine — the recovery uses the policy's authoritative read.)

**`interactiveRenderer(policies)` (policy-aware variant):** add an overload/variant of the S3 renderer that, given `policies`, renders via `policyFor(req.platform).renderInteractive(part.options, part.prompt)`. Keep the existing parameterless `interactiveRenderer()` (S3) for the no-policy path.

**Modify** `engagement/src/index.ts` — export `whatsappPolicy`, `closedWindowRecovery`, the policy-aware `interactiveRenderer`. `messaging` index — export `isTagCapable`.

**Create** `engagement/test/whatsapp-policy.test.ts`.

## 4. Acceptance criteria
1. `whatsappPolicy(...)` returns the `ChannelPolicy` per §3 (window via WindowStore, `closedWindow:{template,strategist}`, renderInteractive=renderChoices, resolveInbound=interactive-then-text, consentRequired true).
2. `closedWindowRecovery([waPolicy])` converts closed-window WhatsApp **text** → template (strategist) or defers; passes open-window; non-text on closed → passed to the guard (which defers).
3. Tagged-text seam added (payload `tag?`, `sendTextWithTag?`, `isTagCapable`, pipeline sink uses it); untagged text unchanged.
4. **`whatsapp_policy_unchanged_behavior`**: pipeline `[closedWindowRecovery([waPolicy]), windowGuard]` reproduces S1–S3 WhatsApp behavior — closed-window text→template at sink; open-window text sends; over-limit render rejects; inbound button routes by id (via `waPolicy.resolveInbound`).
5. `bun run build` + `typecheck:all` green; **full `bun test packages/kuralle-messaging packages/kuralle-messaging-meta packages/kuralle-engagement` green** (no regression — the S1/S2/S3 tests still pass; the terminal windowGuard is unchanged).

## 5. What NOT to do
- Do NOT modify or remove the terminal `windowGuard` (it stays the backstop) or break S1/S2/S3 tests.
- No Instagram policy (S6-03) — but the tagged-text seam you add here is what S6-03 uses.
- No `engagement({policies})` bridge wiring (Sprint 7).
- No `any`/`@ts-ignore`/`--no-verify`/silent catch.

## 6. Validation contract (`.handoff/proof-s6-01.json`)
`assertions_required`: `REQ-22`, `test:whatsapp_policy_unchanged_behavior`, `cmd:typecheck_all`.

| claim_id | command | satisfies_assertions |
|----------|---------|----------------------|
| wa-policy-test | `bun test packages/kuralle-engagement/test/whatsapp-policy.test.ts` | REQ-22, test:whatsapp_policy_unchanged_behavior |
| full-suite | `bun test packages/kuralle-messaging packages/kuralle-messaging-meta packages/kuralle-engagement` | REQ-22 (no regression) |
| typecheck | `bun run typecheck:all` | cmd:typecheck_all |

### PROOF SCHEMA CHEAT-SHEET (follow exactly)
- `claims[].type` ∈ **`test_suite`|`typecheck`|`lint`|`http`|`custom_command`|`ui_recording`|`file_exists`** only.
- Each claim: **`id`** (NOT `claim_id`) = sidecar basename (`.handoff/proof-s6-01-<id>.stdout`) + `stdout_sidecar`, `command`, `cwd`, `exit_code`, `stdout_sha256`, `satisfies_assertions`.
- `commands_run[]` `purpose`=`"verification"`; `claim_id` matches a `claims[].id`. `assertions_satisfied`==`assertions_required`. Sentinel `echo "DONE $(git rev-parse HEAD) proof=.handoff/proof-s6-01.json" > .handoff/result-s6-01.done`.

## 7. Demo artifact
`sprints/sprint-6/artifacts/s6-01-tests.txt` — named test + full-suite tail. **`git add` it.**

## 8. Report back
Files, commit sha, proof slug `s6-01`, DoD, demo, trade-offs (esp. the resolveInbound sync wrapping + the tagged-text seam). **No `*-implementation-notes.md`.** No PR.

## 9. If stuck
- If `renderChoices`/the S3 resolver aren't importable as-is for the policy, wrap their logic; don't duplicate divergently. Flag if a needed S3 export is missing.
- Baseline green pre-story (875 tests). No shortcuts; do NOT weaken the terminal windowGuard.
