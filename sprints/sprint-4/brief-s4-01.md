# Story Brief — `S4-01` D1: OwnershipStore + inbound ownership gate (R-08)

> **IC engineer (`cursor`, fresh process).** Self-contained. Ambiguity → **stop and ask**.
> **Atomic-commit:** `[S4-01] D1 OwnershipStore + inbound ownership gate` on **`plan/whatsapp-engagement`**. No push/`main`, one commit. **Bun.**

## 1. Goal
Add an `OwnershipStore` (interface in messaging, SessionStore-backed impl in engagement). In `createMessagingRouter`, gate the **inbound** path: while human-owned, record the inbound and **do NOT call `runtime.run`** (no side effects). `escalate→'human'` claims ownership via the emitted terminal-handoff part (S0-05). `ownershipGate` outbound middleware suppresses while owned. Release resumes. Proven by `human_owned_inbound_does_not_run_flow`, `escalate_claims_ownership`, `ownership_gate_suppresses`.

## 2. Required reading
1. `sprints/STATE.md`; `sprints/sprint-4/PLAN.md` § Story `S4-01` + § 0.
2. RFC `02-...` **§4.7** (`OwnershipStore`, `ownershipGate`), **§4.11** (inbound ownership gate + handoff-to-human seam), **REQ-10/21**; `03-...` **§6.1** (ownershipGate), **§6.5** (inbound gate before `runtime.run`).
3. Source:
   - `packages/kuralle-messaging/src/adapter/createMessagingRouter.ts` — `onMessage` handler (post-S3: dedup → recordInbound → resolve session → `inboundChain.resolve` → `runtime.run` → `mapStream`). The inbound gate goes **before `runtime.run`**; the claim-on-handoff goes **after** `mapStream` (which returns the emitted parts).
   - `packages/kuralle-messaging/src/types/adapter.ts` — `MessagingRouterConfig` (+`ownership?`), `RuntimeLike`.
   - `packages/kuralle-messaging/src/adapter/window-store.ts` — the `WindowStore` interface pattern (put `OwnershipStore` in a sibling `messaging/src/types/stores.ts` or `adapter/ownership-store.ts` — your call, exported from index).
   - `packages/kuralle-core/src/runtime/Runtime.ts` — `getSessionStore(): SessionStore` (~253); S0-05 terminal handoff emits `{type:'handoff', targetAgent:'human'}`. Check whether `RuntimeLike` (the config.runtime type) exposes `getSessionStore`/session access — if not, see §3 note.
   - `packages/kuralle-core/src/session/SessionStore.ts` — `get(id)/save(session)`; `Session` has `messages`, `workingMemory`, `metadata?`.
   - `packages/kuralle-messaging/src/types/outbound.ts` — `OutboundMiddleware`, `SendOutcome` (`suppressed`).
   - Test fixtures: `packages/kuralle-messaging/test/unhappy-paths.test.ts` (`createMockPlatform`, `createMockRuntime`).

> `bun run build` first.

## 3. Specs
**`OwnershipStore` interface (messaging):**
```ts
export interface OwnershipStore {
  owner(threadId: string): Promise<'bot' | 'human'>;
  claim(threadId: string, by: string): Promise<void>;
  release(threadId: string): Promise<void>;
}
```
Export from messaging index. `MessagingRouterConfig.ownership?: OwnershipStore`.

**Inbound gate in `createMessagingRouter.onMessage`** — after session resolve, **before** `inboundChain.resolve`/`runtime.run`:
```ts
if (config.ownership && (await config.ownership.owner(message.threadId)) === 'human') {
  // record inbound to history; do NOT run the flow (no side effects while human-owned)
  await recordInboundToHistory(message, sessionId);   // see note
  return;
}
```
`recordInboundToHistory`: append a `{role:'user', content: message.text ?? ''}` to the session via the session store. **Note:** if `RuntimeLike` exposes `getSessionStore()` (or a session accessor), use it (`config.runtime.getSessionStore?.()`); if `RuntimeLike` does NOT expose session access, add `getSessionStore?(): SessionStore` to `RuntimeLike` (additive optional) and use it — or, if that's too invasive, record via a minimal `config.ownership`-adjacent hook and **flag the limitation in your report**. The REQUIRED behavior is: `runtime.run` is NOT called while human-owned (assert it); recording is secondary.

**Claim-on-handoff** — after `const parts = await streamMapper.mapStream(...)`:
```ts
if (config.ownership && parts.some(p => p.type === 'handoff' && p.targetAgent === 'human')) {
  await config.ownership.claim(message.threadId, 'human');
}
```
(`mapStream` returns `HarnessStreamPart[]` — capture it.)

**`sessionOwnershipStore(sessionStore: SessionStore): OwnershipStore` (engagement, `src/ownership.ts`):** conversation-keyed; store the owner flag in the conversation session's `workingMemory` (or `metadata`) under a reserved key (e.g. `__ownership`). `owner` returns `'bot'` when unset. `claim`/`release` set/clear the flag (load session, set, save). Create the session if absent (minimal).

**`ownershipGate(ownership: OwnershipStore): OutboundMiddleware` (engagement):** name `'ownership-gate'`; `if (await ownership.owner(req.threadId) === 'human') return { kind:'suppressed', reason:'human-owned' }; return next(req);`. Installed before the terminal `windowGuard`.

**Files:** messaging: `OwnershipStore` interface + index export + `createMessagingRouter.ts` (gate + claim) + `types/adapter.ts` (`ownership?`) (+ `RuntimeLike.getSessionStore?` if needed). engagement: `src/ownership.ts` + index export. Tests: `messaging/test/ownership-gate.test.ts` (inbound gate + claim) and/or `engagement/test/ownership.test.ts` (store + gate).

**Do not touch:** consent (S4-02), the strategist/renderer/resolver, the window guard internals.

## 4. Acceptance criteria
1. `OwnershipStore` interface in messaging + `config.ownership?`; `sessionOwnershipStore` impl in engagement (default owner `'bot'`).
2. **Inbound gate: human-owned ⇒ `runtime.run` NOT called** (behavioral assertion), inbound recorded.
3. Emitted handoff-to-human part ⇒ `ownership.claim` (owner becomes `'human'`).
4. `ownershipGate` suppresses outbound while owned (`suppressed`, zero client calls).
5. Release ⇒ next inbound calls `runtime.run` (resume).
6. Tests `human_owned_inbound_does_not_run_flow`, `escalate_claims_ownership`, `ownership_gate_suppresses` pass.
7. `bun run build` + `typecheck:all` green; `bun test packages/kuralle-messaging packages/kuralle-engagement` green.

## 5. What NOT to do
- No consent/STOP (S4-02). No new FlowNode kind. Don't change S0-05's terminal-handoff logic (consume its emitted part).
- No `any`/`@ts-ignore`/`--no-verify`/silent catch.

## 6. Validation contract (`.handoff/proof-s4-01.json`)
`assertions_required`: `REQ-10`, `REQ-21`, `test:human_owned_inbound_does_not_run_flow`, `test:escalate_claims_ownership`, `test:ownership_gate_suppresses`, `cmd:typecheck_all`.

| claim_id | command | satisfies_assertions |
|----------|---------|----------------------|
| own-test | `bun test packages/kuralle-messaging/test/ownership-gate.test.ts` | REQ-10, REQ-21, test:human_owned_inbound_does_not_run_flow, test:escalate_claims_ownership, test:ownership_gate_suppresses |
| eng-suite | `bun test packages/kuralle-engagement` | REQ-10 (store impl) |
| msg-suite | `bun test packages/kuralle-messaging` | REQ-21 (router regression) |
| typecheck | `bun run typecheck:all` | cmd:typecheck_all |

### PROOF SCHEMA CHEAT-SHEET (follow exactly)
- `claims[].type` ∈ **`test_suite`|`typecheck`|`lint`|`http`|`custom_command`|`ui_recording`|`file_exists`** only.
- Each claim: **`id`** (NOT `claim_id`) = sidecar basename (`.handoff/proof-s4-01-<id>.stdout`) + `stdout_sidecar`, `command`, `cwd`, `exit_code`, `stdout_sha256`, `satisfies_assertions`.
- `commands_run[]` `purpose`=`"verification"`; `claim_id` matches a `claims[].id`. `assertions_satisfied`==`assertions_required`. Sentinel `echo "DONE $(git rev-parse HEAD) proof=.handoff/proof-s4-01.json" > .handoff/result-s4-01.done`.

## 7. Demo artifact
`sprints/sprint-4/artifacts/s4-01-tests.txt` — named tests + typecheck tail. **`git add` it.**

## 8. Report back
Files, commit sha, proof slug `s4-01`, DoD, demo, trade-offs (esp. how you recorded the inbound to history + whether `RuntimeLike` needed `getSessionStore?`). **No `*-implementation-notes.md`** (root or sprint dir). No PR.

## 9. If stuck
- If `RuntimeLike` can't reach a SessionStore for recording, prioritize the REQUIRED behavior (`runtime.run` not called while owned) and flag the recording limitation — don't fake it.
- Baseline green pre-story (853 tests). No shortcuts.
