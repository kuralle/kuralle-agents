# Story Brief — `S5-02` E2: broadcast engine + BroadcastLedger (R-07)

> **IC engineer (`cursor`, fresh process).** Self-contained. Ambiguity → **stop and ask**.
> **Atomic-commit:** `[S5-02] E2 broadcast engine + BroadcastLedger` on **`plan/whatsapp-engagement`**. No push/`main`, one commit. **Bun.**

## 1. Goal
A `BroadcastLedger` (atomic `putIfAbsent`) + `createBroadcasts({pipeline, consent, ledger, platform})` whose `.send(campaign)` sends an approved template through the pipeline to **opted-in** recipients, **idempotent across retry** via the ledger (NOT the per-run effect log — R-07). A reply enters a flow via the normal inbound path. Proven by `broadcast_ledger_idempotent_per_campaign_recipient`, `broadcast_reply_enters_flow`.

## 2. Required reading
1. `sprints/STATE.md`; `sprints/sprint-5/PLAN.md` § Story `S5-02` + § 0 (esp. R-07).
2. RFC `02-...` **§4.7** (`BroadcastLedger`), **REQ-12**; `03-...` **§6.5** (broadcast pseudocode + R-07 note); `05-...` **R-07** (why not the effect log: `runId==sessionId`, no `seed`).
3. Source:
   - `packages/kuralle-messaging/src/adapter/outbound-pipeline.ts` — `OutboundPipeline.send({threadId, platform, payload, meta})`; `packages/kuralle-messaging/src/types/outbound.ts` — `OutboundPayload` (`{kind:'template', template}`), `OutboundMeta`, `WindowState`, `SendOutcome`.
   - `packages/kuralle-engagement/src/consent.ts` (S4-02) — `ConsentStore.isOptedIn(customerId)`.
   - `packages/kuralle-engagement/src/strategist.ts` / `OutboundTemplate` (S1/S2) — the approved template shape.
   - `packages/kuralle-core/src/runtime/openRun.ts:31` — `sessionDerivedRunId` (`runId == sessionId`); read the comment for why the effect log can't dedupe broadcasts.
   - Router/runtime test harness for the reply-enters-flow test: `packages/kuralle-messaging/test/ownership-gate.test.ts` (mock runtime with `runCount`).

> `bun run build` first (S5-01 scheduler in dist if you reference it; broadcast itself doesn't need the scheduler — drips do, S5-03).

## 3. Specs
**`engagement/src/broadcast-ledger.ts`:**
```ts
export interface BroadcastLedger {
  /** Atomic compare-and-set. Returns true if newly added, false if the key already existed. */
  putIfAbsent(key: string): Promise<boolean>;
}
export function createInMemoryBroadcastLedger(): BroadcastLedger {
  const seen = new Set<string>();
  return { async putIfAbsent(key) { if (seen.has(key)) return false; seen.add(key); return true; } };
}
```
(A `SessionStore`-backed durable ledger is backlog; in-memory default here. The atomicity that matters for the test is "second call with same key → false".)

**`engagement/src/broadcast.ts`:**
```ts
import type { OutboundPipeline, OutboundTemplate, WindowState } from '@kuralle-agents/messaging';
import type { ConsentStore } from '@kuralle-agents/messaging';
import type { BroadcastLedger } from './broadcast-ledger.js';

export interface Campaign {
  id: string;
  template: OutboundTemplate;
  recipients: { customerId: string; threadId: string }[];
}

export interface BroadcastApi {
  send(campaign: Campaign): Promise<{ sent: number; skipped: number }>;
}

export function createBroadcasts(opts: {
  pipeline: OutboundPipeline;
  consent: ConsentStore;
  ledger: BroadcastLedger;
  platform: string;
  window?: (threadId: string) => Promise<WindowState>;   // for meta.window; default a closed window is fine (template is window-agnostic)
}): BroadcastApi {
  return {
    async send(campaign) {
      let sent = 0, skipped = 0;
      for (const r of campaign.recipients) {
        if (!(await opts.consent.isOptedIn(r.customerId))) { skipped++; continue; }
        const key = `${campaign.id}:${r.customerId}`;
        if (!(await opts.ledger.putIfAbsent(key))) { skipped++; continue; }   // R-07 idempotency
        const window: WindowState = (await opts.window?.(r.threadId)) ?? { open: false, expiresAt: null };
        await opts.pipeline.send({
          threadId: r.threadId,
          platform: opts.platform,
          payload: { kind: 'template', template: campaign.template },
          meta: { window, parts: [], sessionId: r.threadId, userId: r.customerId },
        });
        sent++;
      }
      return { sent, skipped };
    },
  };
}
```
(Confirm `ConsentStore`/`OutboundPipeline`/`OutboundTemplate`/`WindowState` are exported from `@kuralle-agents/messaging` — they are, from S1/S4. If `ConsentStore` is exported from messaging, import from there; else from engagement.)

**Modify** `engagement/src/index.ts` — export `BroadcastLedger`, `createInMemoryBroadcastLedger`, `Campaign`, `BroadcastApi`, `createBroadcasts`.
**Create** `engagement/test/broadcast.test.ts`.

## 4. Acceptance criteria
1. `BroadcastLedger.putIfAbsent` atomic (2nd same-key call → false); `createInMemoryBroadcastLedger`.
2. `createBroadcasts(...).send(campaign)`: opted-in only; ledger-deduped; sends `{kind:'template'}` through the pipeline; returns `{sent, skipped}`.
3. **Idempotent across retry** — `broadcast_ledger_idempotent_per_campaign_recipient`: run `.send(campaign)` twice with a recording pipeline; total pipeline sends == number of opted-in recipients (each once); the 2nd run sends 0. Assert this uses the ledger (a fresh ledger → sends again; same ledger → no-op) — i.e. NOT the per-run effect log.
4. Un-opted-in recipients are skipped (no send).
5. `broadcast_reply_enters_flow`: an inbound from a recipient threadId runs the flow via the normal router path (reuse the mock-runtime `runCount` harness — assert `runCount === 1` after the inbound). (This is the existing router behavior; the test documents that a broadcast reply needs no special path.)
6. `bun run build` + `typecheck:all` green; `bun test packages/kuralle-engagement packages/kuralle-messaging` green.

## 5. What NOT to do
- Do NOT use the per-run effect log / `runId` for idempotency — explicit ledger only (R-07).
- No drip/scheduler wiring (S5-03). No scheduler dependency in broadcast.
- No `any`/`@ts-ignore`/`--no-verify`/silent catch.

## 6. Validation contract (`.handoff/proof-s5-02.json`)
`assertions_required`: `REQ-12`, `test:broadcast_ledger_idempotent_per_campaign_recipient`, `test:broadcast_reply_enters_flow`, `cmd:typecheck_all`.

| claim_id | command | satisfies_assertions |
|----------|---------|----------------------|
| bcast-test | `bun test packages/kuralle-engagement/test/broadcast.test.ts` | REQ-12, test:broadcast_ledger_idempotent_per_campaign_recipient, test:broadcast_reply_enters_flow |
| eng-suite | `bun test packages/kuralle-engagement` | REQ-12 (regression) |
| typecheck | `bun run typecheck:all` | cmd:typecheck_all |

### PROOF SCHEMA CHEAT-SHEET (follow exactly)
- `claims[].type` ∈ **`test_suite`|`typecheck`|`lint`|`http`|`custom_command`|`ui_recording`|`file_exists`** only.
- Each claim: **`id`** (NOT `claim_id`) = sidecar basename (`.handoff/proof-s5-02-<id>.stdout`) + `stdout_sidecar`, `command`, `cwd`, `exit_code`, `stdout_sha256`, `satisfies_assertions`.
- `commands_run[]` `purpose`=`"verification"`; `claim_id` matches a `claims[].id`. `assertions_satisfied`==`assertions_required`. Sentinel `echo "DONE $(git rev-parse HEAD) proof=.handoff/proof-s5-02.json" > .handoff/result-s5-02.done`.

## 7. Demo artifact
`sprints/sprint-5/artifacts/s5-02-tests.txt` — named tests + typecheck tail. **`git add` it.**

## 8. Report back
Files, commit sha, proof slug `s5-02`, DoD, demo, trade-offs (esp. confirming idempotency is ledger-based, not effect-log). **No `*-implementation-notes.md`.** No PR.

## 9. If stuck
- If `ConsentStore`/`OutboundPipeline` aren't exported where expected, trace the index; flag if a re-export is needed.
- Baseline green pre-story. No shortcuts.
