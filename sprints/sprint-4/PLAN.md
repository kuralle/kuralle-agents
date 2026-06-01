# Sprint 4 — Plan

**Sprint name:** Handoff & consent
**Sprint goal (one sentence):** A human-owned conversation suppresses the bot on inbound and resumes on release; un-opted-in/STOP customers are never messaged.
**Sprint window:** 2026-06-01 → 2026-06-08
**Author (main session):** Opus 4.8 (1M) · 2026-06-01

---

## 0. Decisions made before briefing (read first)

- **Interface placement (mirrors `WindowStore`).** `OwnershipStore` and `ConsentStore` **interfaces** live in `@kuralle-agents/messaging` (so `createMessagingRouter` can reference them in config — the inbound ownership gate and the STOP handler run in the router). Their **`SessionStore`-backed impls** + the `ownershipGate`/`consentGate` middleware live in `@kuralle-agents/engagement`. `MessagingRouterConfig` gains `ownership?: OwnershipStore` and `consent?: ConsentStore`.
- **Inbound ownership gate is the primary control (REQ-21/R-08).** In `createMessagingRouter.onMessage`, **before `runtime.run`**: if `ownership.owner(threadId) === 'human'`, record the inbound to session history and **return** (do NOT call `runtime.run` — no flow side effects fire). Outbound suppression alone is insufficient because the runtime executes on inbound. The `ownershipGate` (outbound middleware) is defense-in-depth (`suppressed` while owned).
- **`escalate→'human'` → claim, deterministically.** S0-05 makes `escalate→'human'` pause the run and **emit a `{type:'handoff', targetAgent:'human'}` stream part** (no missing-agent throw). The router, after the turn, inspects the emitted parts (`mapStream` returns them) and if a handoff to a configured terminal target was emitted, calls `ownership.claim(threadId, 'human')`. This is deterministic (the part is always emitted on escalate) — no reliance on a follow-up send.
- **Release resumes.** `ownership.release(threadId)` flips owner back to `'bot'`; the next inbound runs the flow normally (the run was paused, not ended — it resumes via the normal inbound path).
- **Consent keyed by `customerId` (REQ-19).** `ConsentStore` is customer-keyed (`message.customerId`, which the resolver exposes as `userId`/`meta.userId`). `consentGate` reads `meta.userId` and defers (`not-opted-in`) when not opted in. **STOP** handling: the router detects an inbound whose text is `STOP` (case-insensitive, trimmed) and calls `consent.optOut(customerId)` (before/instead of running) — future sends are then blocked by `consentGate`. (Drips don't exist until Sprint 5; "halts drip" is satisfied for now by consent blocking the send.)
- **SessionStore-backed store impls.** Ownership (conversation-keyed) stores a flag in the conversation's session (`workingMemory`/`metadata` under a reserved key). Consent (customer-keyed) uses a synthetic customer session id (e.g. `consent:{customerId}`) holding the opt-in flag. Keep it minimal; default impls only (durable/external backends are backlog).

---

## 1. Stories

### `S4-01` — D1: OwnershipStore + inbound ownership gate (R-08)
**Description:** `OwnershipStore` interface (messaging) + `sessionOwnershipStore(sessionStore)` impl (engagement, conversation-keyed). Inbound ownership gate in `createMessagingRouter` (suppress `runtime.run` while human-owned; record inbound). `escalate→'human'` → `ownership.claim` via the emitted terminal-handoff part. `ownershipGate` outbound middleware (suppressed while owned). Release resumes.
**Acceptance criteria:**
1. `OwnershipStore { owner(threadId): Promise<'bot'|'human'>; claim(threadId, by: string): Promise<void>; release(threadId): Promise<void> }` in messaging; exported. `MessagingRouterConfig.ownership?`.
2. `sessionOwnershipStore(sessionStore)` in engagement implements it (SessionStore-backed, conversation-keyed). Default `owner` = `'bot'` when unset.
3. Inbound gate: `ownership.owner(threadId)==='human'` ⇒ record inbound to history, **do NOT call `runtime.run`**. (Behavioral test asserts `runtime.run` not called.)
4. After a turn, if a `{type:'handoff', targetAgent:'human'}` part was emitted (S0-05), the router calls `ownership.claim(threadId, 'human')`.
5. `ownershipGate(ownership): OutboundMiddleware` short-circuits to `{kind:'suppressed', reason:'human-owned'}` when owned (defense-in-depth).
6. Release: after `ownership.release(threadId)`, the next inbound calls `runtime.run` again (resume).
7. Tests: `human_owned_inbound_does_not_run_flow` (owned ⇒ runtime.run NOT called, inbound recorded; release ⇒ runtime.run called), `escalate_claims_ownership` (an emitted handoff-to-human part ⇒ `ownership.owner` becomes `'human'`), `ownership_gate_suppresses` (outbound while owned ⇒ `suppressed`, zero client calls).
**Files:** `messaging/src/types/` (OwnershipStore interface), `createMessagingRouter.ts` (inbound gate + claim-on-handoff), `types/adapter.ts` (`ownership?`), `messaging/src/index.ts`; `engagement/src/ownership.ts` (`sessionOwnershipStore` + `ownershipGate`), `engagement/src/index.ts`; tests in both packages.

### `S4-02` — D2: ConsentStore + consentGate + STOP
**Description:** `ConsentStore` interface (messaging) + `sessionConsentStore(sessionStore)` impl (engagement, customer-keyed). `consentGate(consent): OutboundMiddleware` blocks outbound for un-opted-in / opted-out (`deferred:'not-opted-in'`). `STOP` inbound → `consent.optOut(customerId)`.
**Acceptance criteria:**
1. `ConsentStore { isOptedIn(customerId): Promise<boolean>; optOut(customerId): Promise<void>; optIn(customerId): Promise<void> }` in messaging; exported. `MessagingRouterConfig.consent?`.
2. `sessionConsentStore(sessionStore)` in engagement (SessionStore-backed, **customer-keyed**). Default `isOptedIn` policy: document whether default is opted-in or opted-out — per REQ-11 "no outbound unless opted in", **default opted-out** (must explicitly opt in) OR a configurable default; pick **default opted-out** and note it (safest for REQ-11). [If the demo needs opted-in-by-default, make it a constructor option defaulting to false.]
3. `consentGate(consent)` reads `meta.userId` (= customerId) ⇒ `isOptedIn` false ⇒ `{kind:'deferred', reason:'not-opted-in'}`; installed before the terminal `windowGuard`.
4. STOP: router detects `message.text?.trim().toUpperCase() === 'STOP'` ⇒ `consent.optOut(message.customerId)` (and may skip running the flow / send a final confirmation through the pipeline — keep minimal: opt out + don't run).
5. Tests: `not_opted_in_blocks_send` (un-opted-in ⇒ outbound `deferred`, zero client calls), `stop_opts_out_and_halts_drip` (after STOP, `isOptedIn` false ⇒ subsequent send blocked).
**Files:** `messaging/src/types/` (ConsentStore interface), `createMessagingRouter.ts` (STOP), `types/adapter.ts` (`consent?`), `messaging/src/index.ts`; `engagement/src/consent.ts` (`sessionConsentStore` + `consentGate`), `engagement/src/index.ts`; tests.

---

## 2. Universal DoD
Tests happy+failure offline; `bun run build` + `typecheck:all` green; surfaces match RFC §4.7/§4.11; **the inbound-gate test asserts `runtime.run` NOT called** (not just outbound count 0) — REQ-21; no `--no-verify`/suppression/silent-catch; atomic `[S4-{nn}]` commit + proof JSON; commit demo artifacts; no stray `*-implementation-notes.md` (root or sprint dir). Proof-schema cheat-sheet in every brief.

## 3. Test plan
| Story | Named tests |
|-------|-------------|
| S4-01 | `human_owned_inbound_does_not_run_flow`, `escalate_claims_ownership`, `ownership_gate_suppresses` |
| S4-02 | `not_opted_in_blocks_send`, `stop_opts_out_and_halts_drip` |

**Not tested (safe):** drip halting end-to-end (drips are Sprint 5 — consent-block stands in); durable ownership/consent backends (backlog); team-inbox UI (out of scope, BK-02).

## 4. Demo plan
Fake-client: a human claims a chat (escalate or explicit claim) → subsequent inbound recorded, `runtime.run` not called, bot silent; release → next inbound resumes the flow. A `STOP` → opt-out → no further sends (deferred).

## 5. Risks
| Risk | Detection | Mitigation |
|------|-----------|------------|
| Ownership checked only on outbound (side effects still fire on inbound) | flow runs while human-owned | inbound gate before `runtime.run` (REQ-21); test asserts run NOT called. |
| Consent keyed by thread instead of customer | a customer opted out on one thread still messaged on another | key `ConsentStore` by `customerId`; test. |
| Default consent opted-in leaks to un-consented customers | `not_opted_in_blocks_send` would fail | default opted-out; document; configurable. |
| `escalate` claim not deterministic (relies on a follow-up send) | ownership not claimed after escalate | claim from the emitted handoff part inspected after the turn (always emitted, S0-05). |

## 6. Open questions
None blocking. Default-consent policy resolved in §0 (default opted-out, configurable). If recording the inbound to history while human-owned needs a SessionStore API the router lacks, the IC uses `config.runtime.getSessionStore()` (Runtime exposes it) — flag if that's not accessible from the router.
