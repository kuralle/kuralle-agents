# Story Brief — `S4-02` D2: ConsentStore + consentGate + STOP

> **IC engineer (`cursor`, fresh process).** Self-contained. Ambiguity → **stop and ask**.
> **Atomic-commit:** `[S4-02] D2 ConsentStore + consentGate + STOP` on **`plan/whatsapp-engagement`**. No push/`main`, one commit. **Bun.**

## 1. Goal
`ConsentStore` (interface in messaging, SessionStore-backed customer-keyed impl in engagement). `consentGate` blocks outbound for un-opted-in / opted-out customers (`deferred:'not-opted-in'`). An inbound `STOP` opts the customer out. Proven by `not_opted_in_blocks_send`, `stop_opts_out_and_halts_drip`.

## 2. Required reading
1. `sprints/STATE.md`; `sprints/sprint-4/PLAN.md` § Story `S4-02` + § 0.
2. RFC `02-...` **§4.7** (`ConsentStore`, `consentGate`), **REQ-11/19** (consent keyed by customerId); `03-...` **§6.1** (consentGate short-circuits to deferred).
3. Source:
   - `packages/kuralle-messaging/src/adapter/createMessagingRouter.ts` — `onMessage` (S4-01 added the inbound ownership gate); add STOP detection near the top of `onMessage` (after dedup, before/around the ownership gate).
   - `packages/kuralle-messaging/src/types/adapter.ts` — `MessagingRouterConfig` (+`consent?`).
   - `packages/kuralle-messaging/src/adapter/window-store.ts` / S4-01's ownership-store — the interface-placement pattern (put `ConsentStore` alongside).
   - `packages/kuralle-core/src/session/SessionStore.ts` — `get/save`; `Session`.
   - `packages/kuralle-messaging/src/types/outbound.ts` — `OutboundMiddleware`, `OutboundMeta` (`userId` = customerId, set by the router from the resolver), `SendOutcome` (`deferred`).
   - `InboundMessage.customerId` (S0-02) — the consent key.

> `bun run build` first (S4-01 in dist).

## 3. Specs
**`ConsentStore` interface (messaging):**
```ts
export interface ConsentStore {
  isOptedIn(customerId: string): Promise<boolean>;
  optOut(customerId: string): Promise<void>;
  optIn(customerId: string): Promise<void>;
}
```
Export from messaging index. `MessagingRouterConfig.consent?: ConsentStore`.

**`sessionConsentStore(sessionStore, opts?: { defaultOptedIn?: boolean }): ConsentStore` (engagement, `src/consent.ts`):** **customer-keyed** — use a synthetic session id `consent:{customerId}` holding the opt-in flag in `workingMemory`/`metadata`. `isOptedIn` returns the stored flag, or `opts.defaultOptedIn ?? false` when unset (**default opted-out** per REQ-11 — document this; configurable). `optOut`/`optIn` persist the flag.

**`consentGate(consent: ConsentStore): OutboundMiddleware` (engagement):** name `'consent-gate'`:
```ts
async send(req, next) {
  const customerId = req.meta.userId;
  if (!customerId || !(await consent.isOptedIn(customerId))) return { kind:'deferred', reason:'not-opted-in' };
  return next(req);
}
```
Installed before the terminal `windowGuard` (typically first in the chain — consent is the outermost gate). (Note: `meta.userId` is the customerId — the router sets `userId` from the resolver, and `customerId` is the resolver's `userId` per S0-02. Confirm `OutboundMeta.userId` carries the customerId at the send sites; if the router doesn't currently put customerId into `meta.userId`, ensure it does.)

**STOP handling in `createMessagingRouter.onMessage`:** near the top (after dedup), before running:
```ts
if (config.consent && message.text?.trim().toUpperCase() === 'STOP') {
  await config.consent.optOut(message.customerId);
  return;  // do not run the flow; future sends are blocked by consentGate
}
```

**Files:** messaging: `ConsentStore` interface + index export + `createMessagingRouter.ts` (STOP) + `types/adapter.ts` (`consent?`). engagement: `src/consent.ts` (`sessionConsentStore` + `consentGate`) + index export. Tests: `engagement/test/consent.test.ts` (+ a messaging STOP test if needed).

**Do not touch:** ownership (S4-01), strategist/renderer/resolver, window guard internals.

## 4. Acceptance criteria
1. `ConsentStore` interface (messaging) + `config.consent?`; `sessionConsentStore` (engagement, customer-keyed, **default opted-out**, configurable).
2. `consentGate` defers (`not-opted-in`) when the customer isn't opted in; passes when opted in. Installed before `windowGuard`.
3. STOP inbound ⇒ `consent.optOut(customerId)`, flow not run.
4. Tests: `not_opted_in_blocks_send` (un-opted-in ⇒ `deferred`, zero client calls; opted-in ⇒ sends), `stop_opts_out_and_halts_drip` (after STOP, `isOptedIn` false ⇒ subsequent send `deferred`).
5. `bun run build` + `typecheck:all` green; `bun test packages/kuralle-messaging packages/kuralle-engagement` green.

## 5. What NOT to do
- No ownership changes (S4-01). No real drip (Sprint 5 — "halts drip" = consent blocks the send).
- No `any`/`@ts-ignore`/`--no-verify`/silent catch.

## 6. Validation contract (`.handoff/proof-s4-02.json`)
`assertions_required`: `REQ-11`, `REQ-19`, `test:not_opted_in_blocks_send`, `test:stop_opts_out_and_halts_drip`, `cmd:typecheck_all`.

| claim_id | command | satisfies_assertions |
|----------|---------|----------------------|
| consent-test | `bun test packages/kuralle-engagement/test/consent.test.ts` | REQ-11, REQ-19, test:not_opted_in_blocks_send, test:stop_opts_out_and_halts_drip |
| eng-suite | `bun test packages/kuralle-engagement` | REQ-11 (regression) |
| msg-suite | `bun test packages/kuralle-messaging` | REQ-11 (router STOP regression) |
| typecheck | `bun run typecheck:all` | cmd:typecheck_all |

### PROOF SCHEMA CHEAT-SHEET (follow exactly)
- `claims[].type` ∈ **`test_suite`|`typecheck`|`lint`|`http`|`custom_command`|`ui_recording`|`file_exists`** only.
- Each claim: **`id`** (NOT `claim_id`) = sidecar basename (`.handoff/proof-s4-02-<id>.stdout`) + `stdout_sidecar`, `command`, `cwd`, `exit_code`, `stdout_sha256`, `satisfies_assertions`.
- `commands_run[]` `purpose`=`"verification"`; `claim_id` matches a `claims[].id`. `assertions_satisfied`==`assertions_required`. Sentinel `echo "DONE $(git rev-parse HEAD) proof=.handoff/proof-s4-02.json" > .handoff/result-s4-02.done`.

## 7. Demo artifact
`sprints/sprint-4/artifacts/s4-02-tests.txt` — named tests + typecheck tail. **`git add` it.**

## 8. Report back
Files, commit sha, proof slug `s4-02`, DoD, demo, trade-offs (esp. default-consent policy + that `meta.userId` carries customerId at send sites). **No `*-implementation-notes.md`** (root or sprint dir). No PR.

## 9. If stuck
- If `OutboundMeta.userId` is not the customerId at the send sites, trace where the router builds `meta` (S1-03 `StreamMapper`) and ensure customerId flows through; flag if it requires a wider change.
- Baseline green pre-story. No shortcuts.
