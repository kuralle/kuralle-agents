# Story Brief — `S7-01` F1: `engagement({policies})` wiring

> **IC engineer (`cursor`, fresh process).** Self-contained. Ambiguity → **stop and ask**.
> **Atomic-commit:** `[S7-01] F1 engagement() wiring` on **`plan/whatsapp-engagement`**. No push/`main`, one commit. **Bun.**

## 1. Goal
`engagement(opts)` → `{ bridge, broadcasts }` that composes the channel-agnostic outbound chain + inbound resolver + stores from the injected `policies`/stores; `.bridge` spreads into `createMessagingRouter`. Proven by `engagement_composes_bridge`, `engagement_inbound_resolver_dispatches_by_platform`.

## 2. Required reading
1. `sprints/STATE.md`; `sprints/sprint-7/PLAN.md` § Story `S7-01` + § 0 (esp. chain order — windowGuard appended by the router, NOT in bridge.outbound; and the `.broadcasts` wiring decision).
2. RFC `02-...` **§4.5** (`engagement(opts)` → `{bridge, broadcasts}`); **REQ-22**.
3. Source:
   - `packages/kuralle-engagement/src/index.ts` — current exports (all gates/policies/middleware/broadcasts present): `consentGate`, `ownershipGate`, `closedWindowRecovery`, `interactiveRenderer` (policy-aware variant — confirm its signature), `webPolicy`/`whatsappPolicy`/`instagramPolicy`, `createBroadcasts`, `createInMemoryBroadcastLedger`, `sessionConsentStore`/`sessionOwnershipStore`, the policies' `resolveInbound`.
   - `packages/kuralle-messaging/src/types/adapter.ts` — `MessagingRouterConfig` (has `outbound`/`inputResolver`/`windowStore`/`ownership`/`consent`/`onStatus` — the bridge spreads a `Pick` of these); `InboundResolverPlugin`.
   - `packages/kuralle-messaging/src/adapter/{createMessagingRouter.ts (buildOutboundChain appends windowGuard terminal), input-resolver-chain.ts, window-store.ts}`.
   - `packages/kuralle-engagement/src/policy.ts` — `ChannelPolicy.resolveInbound`.

> `bun run build` first.

## 3. Specs
**`engagement/src/engagement.ts`:**
```ts
import type { ChannelPolicy } from './policy.js';
import type { ConsentStore, OwnershipStore, WindowStore, OutboundMiddleware, InboundResolverPlugin, MessagingRouterConfig } from '@kuralle-agents/messaging';
import { InMemoryWindowStore } from '@kuralle-agents/messaging';
import { consentGate } from './consent.js';
import { ownershipGate } from './ownership.js';
import { closedWindowRecovery } from './closed-window-recovery.js';
import { interactiveRenderer } from './interactive-renderer.js';   // policy-aware variant
import { createBroadcasts, type BroadcastApi } from './broadcast.js';
import { createInMemoryBroadcastLedger, type BroadcastLedger } from './broadcast-ledger.js';
import type { AuditSink } from './strategist.js';
import type { Scheduler } from './scheduler.js';
import type { OutboundPipeline } from '@kuralle-agents/messaging';

export interface EngagementOptions {
  policies: ChannelPolicy[];
  consent?: ConsentStore;
  ownership?: OwnershipStore;
  audit?: AuditSink;
  scheduler?: Scheduler;
  windowStore?: WindowStore;        // shared with the policies; default InMemoryWindowStore
  ledger?: BroadcastLedger;         // for broadcasts
  broadcastPipeline?: OutboundPipeline;  // §0: the pipeline broadcasts send through (caller-supplied)
}

export type EngagementBridge = Pick<MessagingRouterConfig, 'outbound' | 'inputResolver' | 'windowStore' | 'ownership' | 'consent' | 'onStatus'>;

export function engagement(opts: EngagementOptions): { bridge: EngagementBridge; broadcasts: BroadcastApi } {
  const windowStore = opts.windowStore ?? new InMemoryWindowStore();
  const outbound: OutboundMiddleware[] = [];
  if (opts.consent) outbound.push(consentGate(opts.consent));
  if (opts.ownership) outbound.push(ownershipGate(opts.ownership));
  outbound.push(closedWindowRecovery(opts.policies));
  outbound.push(interactiveRenderer(opts.policies));        // policy-aware
  // NOTE: windowGuard is appended by createMessagingRouter.buildOutboundChain — do NOT add it here.

  const inputResolver: InboundResolverPlugin[] = [policyInboundResolver(opts.policies)];

  const bridge: EngagementBridge = {
    outbound, inputResolver, windowStore,
    ownership: opts.ownership, consent: opts.consent,
  };

  const ledger = opts.ledger ?? createInMemoryBroadcastLedger();
  const broadcasts = createBroadcasts({
    pipeline: opts.broadcastPipeline!,   // caller supplies; see §0 — if undefined, broadcasts.send throws a clear error
    consent: opts.consent ?? alwaysOptedIn(),   // broadcasts require consent; default permissive only if none given (document)
    ledger,
    platform: opts.policies[0]?.channel ?? 'whatsapp',
  });

  return { bridge, broadcasts };
}
```
- **`policyInboundResolver(policies): InboundResolverPlugin`** — `{ name:'policy-inbound', async tryResolve(m) { const p = policies.find(p => p.channel === m.platform); if (!p) return undefined; return p.resolveInbound(m); } }`. (A no-match returns undefined → the router's chain falls through; ensure a text catch-all exists — either append a `TextResolver` or have the policy resolveInbound always return a text fallback. Confirm the router's default behavior and keep free-text working.)
- **`interactiveRenderer(policies)`** — use the policy-aware variant from S6-01 (confirm its exported signature; if it's `interactiveRenderer(policies?)`, pass `policies`).
- **`.broadcasts`** — per §0, the broadcast pipeline is caller-supplied (`opts.broadcastPipeline`); if absent, `broadcasts.send` should throw a clear "no broadcast pipeline configured" error (don't silently no-op). Document this in your report. (F2's example wires a real WhatsApp broadcast pipeline.)

**Modify** `engagement/src/index.ts` — export `engagement`, `EngagementOptions`, `EngagementBridge`, `policyInboundResolver`.
**Create** `engagement/test/engagement.test.ts`.

## 4. Acceptance criteria
1. `engagement(opts)` returns `{bridge, broadcasts}`; `bridge` is a `Pick<MessagingRouterConfig,...>` per §3.
2. `bridge.outbound` order: `[consentGate?, ownershipGate?, closedWindowRecovery, interactiveRenderer]` (gates only when the store is provided); **windowGuard NOT included**.
3. **`engagement_composes_bridge`**: `createMessagingRouter({runtime: mockRuntime, platforms:{whatsapp: mockClient}, ...engagement({policies:[whatsappPolicy(...)], consent, ownership}).bridge})` constructs **without throwing** (the router appends windowGuard terminal → valid pipeline). Assert `bridge.outbound` has the gates + recovery + renderer in order.
4. **`engagement_inbound_resolver_dispatches_by_platform`**: `policyInboundResolver([waPolicy, igPolicy])` resolves a `whatsapp` inbound via the WA policy and an `instagram` inbound via the IG policy (by `m.platform`); free text still resolves.
5. `bun run build` + `typecheck:all` green; full suite green.

## 5. What NOT to do
- Do NOT put `windowGuard` in `bridge.outbound` (the router appends it; double-guard would break the terminal assertion).
- Do NOT change `createMessagingRouter` or the policies (compose them).
- If `.broadcasts` can't be wired without exposing platform clients on the `ChannelPolicy` interface, **stop and flag** (that would be an RFC amendment) — otherwise use the caller-supplied `broadcastPipeline` per §0.
- No `any`/`@ts-ignore`/`--no-verify`/silent catch.

## 6. Validation contract (`.handoff/proof-s7-01.json`)
`assertions_required`: `REQ-22`, `test:engagement_composes_bridge`, `test:engagement_inbound_resolver_dispatches_by_platform`, `cmd:typecheck_all`.

| claim_id | command | satisfies_assertions |
|----------|---------|----------------------|
| eng-wire-test | `bun test packages/kuralle-engagement/test/engagement.test.ts` | REQ-22, test:engagement_composes_bridge, test:engagement_inbound_resolver_dispatches_by_platform |
| full-suite | `bun test packages/kuralle-messaging packages/kuralle-messaging-meta packages/kuralle-engagement` | REQ-22 (no regression) |
| typecheck | `bun run typecheck:all` | cmd:typecheck_all |

### PROOF SCHEMA CHEAT-SHEET (follow exactly)
- `claims[].type` ∈ **`test_suite`|`typecheck`|`lint`|`http`|`custom_command`|`ui_recording`|`file_exists`** only.
- Each claim: **`id`** (NOT `claim_id`) = sidecar basename (`.handoff/proof-s7-01-<id>.stdout`) + `stdout_sidecar`, `command`, `cwd`, `exit_code`, `stdout_sha256`, `satisfies_assertions`.
- `commands_run[]` `purpose`=`"verification"`; `claim_id` matches a `claims[].id`. `assertions_satisfied`==`assertions_required`. Sentinel `echo "DONE $(git rev-parse HEAD) proof=.handoff/proof-s7-01.json" > .handoff/result-s7-01.done`.

## 7. Demo artifact
`sprints/sprint-7/artifacts/s7-01-tests.txt` — named tests + typecheck tail. **`git add` it.**

## 8. Report back
Files, commit sha, proof slug `s7-01`, DoD, demo, trade-offs (esp. the final `engagement()` options shape + how `.broadcasts` is wired/guarded). **No `*-implementation-notes.md`.** No PR.

## 9. If stuck
- Confirm the policy-aware `interactiveRenderer(policies)` signature from S6-01; if it's parameterless, check S6-01's variant. Flag if the policy-aware renderer isn't exported.
- Baseline green pre-story (896 tests). No shortcuts; windowGuard stays terminal (appended by the router).
