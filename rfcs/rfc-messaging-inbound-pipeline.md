# RFC: Runtime-agnostic messaging inbound pipeline

Status: Draft · Author: octalpixel (+ Claude) · Date: 2026-06-12
Supersedes the hand-rolled WhatsApp DO path in `apps/playground/pharmacy-rx-agent`.
Grounded in: `apps/playground/pharmacy-rx-agent/PRODUCTION-GAPS.md` (65-gap audit) and the adversarial design review `.handoff/result-wa-pipeline-design-review.txt` (verdict: not-ready; 9 findings) + `.handoff/wbs-wa-pipeline-design-review.md`.

## 1. Problem statement

Kuralle runs conversational agents over multiple ingress channels. Today two of them share almost no inbound code:

- **Node/Bun messaging** — `packages/kuralle-messaging` `createMessagingRouter` (a Hono app). One webhook → N messages across many threads; stores external (memory/Redis); timers = `setTimeout`. It HAS the production middleware: dedup, coalescing, consent/STOP, 24h window-guard, ownership/handoff, status/reaction/error routing.
- **Cloudflare per-user Durable Object messaging** — the hand-rolled path in `apps/playground/pharmacy-rx-agent/src/{index.ts,wa-agent.ts,wa-turn.ts}`. The Worker verifies the HMAC + normalizes + fans out per `from` to `idFromName('wa:'+from)`; the DO runs the turn over DO-SQLite. This path is MISSING every one of the above and re-implements a thin subset.

The 65-gap audit and the design review show the DO path is **not production-safe**: a Meta retry or crash mid-turn can duplicate a whole user turn (`packages/kuralle-core/src/runtime/openRun.ts:99` appends user input before the turn completes), there is no dedup/ordering/window/consent/handoff, and sessions are keyed only by `from` (no tenant isolation).

**Goal:** express the inbound pipeline **once** and drive it from both topologies, production-safe, with durable checkout intact — and align the Durable-Object side with Cloudflare's own `agents` SDK primitives instead of hand-rolling parallel machinery.

## 2. Goals / Non-goals

**Goals**
- One ordered inbound pipeline (verify happens upstream → dedup/claim → order → consent/STOP → ownership → resolve+media → coalesce → run turn → send; plus status/reaction/error phases) shared by Node and DO.
- A first-class durable **InboundLedger** (atomic claim, append, ordering cursor, processing status, replay) — NOT a narrow dedup borrow.
- Typed, independently-fakeable ports (no god-object).
- DO side reuses Cloudflare `agents` primitives (serial `TurnQueue`, `messageConcurrency` merge/debounce, SQLite schedule + single multiplexed alarm) rather than a parallel scheduler.
- Tenant-scoped keys everywhere (platform + business id + thread).
- Durable checkout (suspend on payment signal, out-of-band resume) preserved on both topologies.
- `createMessagingRouter(config)` remains a backward-compatible **facade** (Node consumers unbroken).

**Non-goals (explicit — must not regress)**
- **The web-chat channel stays exactly as is.** The browser chat client and the CF Agents realtime path (`routeAgentRequest` + `KuralleAgent extends AIChatAgent` + `onChatMessage` + the `cf_agent_*` WS protocol + `/get-messages`) are a **separate ingress** and are OUT OF SCOPE for this pipeline. They MUST keep working byte-for-byte. WhatsApp/Meta is one channel of several; the web chat is another and is not routed through the webhook pipeline. The only shared layer is `createRuntime`/the agent/the session store — which both ingresses already share.
- Real PSP integration, pharmacist approval, legal/compliance gating (Tier-3 in the audit) — tracked separately.

## 3. Strict requirements

- **REQ-1 — Exactly-once inbound.** Every inbound item (message/status/reaction/signal) is claimed atomically by a tenant-scoped key before any side effect; a duplicate (Meta at-least-once retry, re-clicked `/wa-pay`) is a no-op. Claim states: `claimed | duplicate | in_progress`, with `complete()` finalization and a retry policy for crashed-`in_progress`.
- **REQ-2 — Ordering + replay.** Per-conversation events carry a monotonic cursor; processing is replayable after crash/eviction without duplicating a user turn. `openRun.ts:99`'s pre-turn input append must not cause a double turn under retry.
- **REQ-3 — Topology concurrency contract is explicit.** Define same-thread behavior in BOTH topologies (queued / merged / latest-only / debounced / dropped) BEFORE freezing middleware APIs. DO uses CF `agents` serial `TurnQueue`; Node serializes same-thread messages within a webhook.
- **REQ-4 — Coalescing designed up front** (not deferred). One model (debounce + maxWait + maxMessages) over a durable buffer; DO realizes it via CF `agents` `messageConcurrency` + SQLite `schedule` with one multiplexed alarm; Node via a `Scheduler` port. The buffer lives in the ledger (durable on DO).
- **REQ-5 — Typed ports, no god-object.** Core depends on `InboundRuntime`, a record of named ports each independently fakeable: `ledger`, `window`, `consent?`, `ownership?`, `media`, `sender`, `runtime`, `scheduler`, `clock`.
- **REQ-6 — Tenant isolation.** All keys (session, ledger, window, consent, ownership) include `platform + businessId (phoneNumberId/pageId) + threadId`. Same `from` across two business numbers must not share state.
- **REQ-7 — Durable checkout preserved.** Suspend = `runtime.run` parks on a signal; resume = deliver `signalDelivery`; exactly-once via the runtime effect log AND a ledger claim on the signal. Works identically on Node (Redis/PG session) and DO (`SqlSessionStore`).
- **REQ-8 — Typed event phases.** `message`, `status`, `reaction`, `error` each have a defined path; statuses update the window/expiry, errors surface to an operator hook. DO parity tests required.
- **REQ-9 — `createMessagingRouter` stays the ergonomic Node constructor — but its API MAY break.** It must keep existing as the one-call Node entry (stateless Node setup is not regressed into hand-assembling ports), but its signature/config may change to fit the new design. There is NO frozen public surface and NO compatibility shim. Instead: every in-repo consumer (`packages/kuralle-messaging-meta/examples/whatsapp-server`, `kuralle-platform`'s messaging ingress, tests) is migrated in the SAME change, and the migration notes record the breaking delta. (Rationale: pre-1.0, whole-graph versioning, consumers are in-repo — a facade would force the new design to contort to the old shape = patch-not-first-class.)
- **REQ-10 — Web chat untouched (see Non-goals).** This is NOT backward-compat; it is scope isolation. The CF Agents realtime ingress (`routeAgentRequest`/`AIChatAgent.onChatMessage`/`cf_agent_*` WS/`/get-messages`) and the browser client are a different channel and must keep working byte-for-byte. A regression test proves it at every stage.
- **REQ-11 — Embrace breaking changes by default**, including deep breaking changes to `@kuralle-agents/cf-agent` for Cloudflare-primitive alignment (REQ-12). The ONLY hard non-break is REQ-10 (web chat). The app DO path, internal messaging types, `MessageDeduplicator`'s sync API, and `createMessagingRouter`'s config may all break — migrate consumers in-tree.
- **REQ-12 — Cloudflare-native by mandate (do not fight the platform).** Cloudflare is a primary deployment target. The DO topology MUST be built ON Cloudflare `agents` primitives — `Agent`/`AIChatAgent` state, the serial `TurnQueue`, `messageConcurrency` (merge/debounce), and `this.schedule()`/the SQLite-schedule single-alarm model — NOT a parallel scheduler/queue/state machine layered on top. Where our `cf-agent` abstractions duplicate or fight what CF provides, delete ours and adopt theirs (breaking changes expected). The `CoalesceScheduler`/coalescer ports collapse to thin wrappers over CF's APIs on the DO, or disappear entirely if `messageConcurrency` covers the need.

## 4. Interface specification

```ts
// ── Tenant-scoped identity (REQ-6) ───────────────────────────────────────────
export interface ConversationKey {
  platform: string;          // 'whatsapp' | 'messenger' | 'instagram'
  businessId: string;        // phoneNumberId / pageId — the tenant
  threadId: string;          // customer wa_id / PSID
}
export type ConvKeyStr = string; // `${platform}:${businessId}:${threadId}`

// ── InboundLedger: durable claim + append + cursor + replay (REQ-1,2) ────────
export type ClaimResult = 'claimed' | 'duplicate' | 'in_progress';
export interface InboundLedger {
  /** Atomic: claim an event id for processing (SETNX / UNIQUE). */
  claim(key: ConversationKey, eventId: string): Promise<ClaimResult>;
  /** Mark a claimed event finished (releases the in_progress state). */
  complete(key: ConversationKey, eventId: string): Promise<void>;
  /** Append the event to the per-conversation log; returns its ordering seq. */
  append(key: ConversationKey, event: InboundEvent): Promise<{ seq: number }>;
  /** Unprocessed tail (seq > cursor), ordered by (timestamp, seq) — for coalesce/replay. */
  readUnprocessed(key: ConversationKey): Promise<InboundEvent[]>;
  /** Advance the durable cursor past a committed batch (CAS-guarded). */
  commitCursor(key: ConversationKey, throughSeq: number, expect: number): Promise<boolean>;
  /** GC events below the cursor older than ttl. */
  prune(key: ConversationKey, ttlMs: number): Promise<number>;
}

// ── The typed inbound event union (REQ-8) ────────────────────────────────────
export type InboundEvent =
  | { kind: 'message';  id: string; ts: number; data: NormalizedMessage }
  | { kind: 'status';   id: string; ts: number; data: NormalizedStatus }
  | { kind: 'reaction'; id: string; ts: number; data: NormalizedReaction }
  | { kind: 'error';    id: string; ts: number; data: NormalizedWebhookError }
  | { kind: 'signal';   id: string; ts: number; data: { name: string; signalId: string; payload?: unknown } };

// ── Typed ports, composed (REQ-5) — NO single god-host ───────────────────────
export interface InboundRuntime {
  ledger: InboundLedger;
  window: WindowStore;            // existing interface, now key-scoped
  consent?: ConsentStore;         // existing
  ownership?: OwnershipStore;     // existing
  media: MediaResolver;           // wraps attachInboundMedia
  sender: OutboundSender;         // wraps OutboundPipeline + windowGuard (existing outbound stays)
  runtime: TurnRunner;            // run a turn / deliver a signal
  scheduler: CoalesceScheduler;   // Node setTimeout | DO: CF agents schedule (one alarm)
  clock: Clock;
}
export interface TurnRunner {
  runTurn(a: { key: ConversationKey; input: UserInputContent; selection?: ResolvedSelection; userId?: string; signal?: AbortSignal }): Promise<TurnResult>;
  deliverSignal(a: { key: ConversationKey; signal: SignalDelivery; signal2?: AbortSignal }): Promise<TurnResult>;
}
export interface TurnResult { parts: HarnessStreamPart[]; suspended?: { signalId: string }; handoffToHuman?: boolean }
export interface CoalesceScheduler {           // debounce + maxWait over ONE wake slot per conv
  arm(key: ConversationKey, atMs: number): Promise<void>;   // latest-wins (re-arm)
  cancel(key: ConversationKey): Promise<void>;
}
export interface Clock { now(): number }

// ── The ordered pipeline (REQ-3) — middleware mirrors the EXISTING outbound chain ─
export type InboundNext = () => Promise<InboundOutcome>;
export interface InboundMiddleware { readonly name: string; handle(ctx: InboundContext, next: InboundNext): Promise<InboundOutcome>; }
export type InboundOutcome =
  | { kind: 'ran'; parts: HarnessStreamPart[] }
  | { kind: 'suspended'; signalId: string }
  | { kind: 'buffered' }                 // admitted to coalescer; turn deferred to flush
  | { kind: 'short'; by: string; reason: 'duplicate'|'opted-out'|'human-owned'|'window-closed'|'no-input'|string };
export interface InboundContext {
  key: ConversationKey;
  event: InboundEvent;
  rt: InboundRuntime;                     // the composed ports
  input?: UserInputContent;              // filled by resolve+media
  selection?: ResolvedSelection;
  locals: Record<string, unknown>;
}
export function createInboundPipeline(mw: InboundMiddleware[]): {
  ingest(key: ConversationKey, event: InboundEvent, rt: InboundRuntime): Promise<InboundOutcome>;
  flush(key: ConversationKey, rt: InboundRuntime): Promise<InboundOutcome>;   // coalesce timer fired
};

// Shipped middleware (ordered): claim → record-window → consent/STOP → ownership →
// resolve+media → coalesce → run-turn (handles suspend) → [status/reaction/error are
// separate phase handlers, not in the message chain]. `signal` events skip straight to deliverSignal.
```

The standard message order is fixed and internal (it is a correctness property: claim before run, ownership before run, window-record before guard). `createMessagingRouter` and the DO assemble the SAME list; only `InboundRuntime` differs.

## 5. Architecture

### 5.1 Node topology (ergonomic constructor — REQ-9)
`createMessagingRouter(config)` stays the one-call Node entry (its config MAY break; in-repo consumers migrated in the same change). Internally it builds an `InboundRuntime` from memory/Redis adapters (`ledger: MemoryInboundLedger|RedisInboundLedger`, existing window/consent/ownership, `scheduler: SetTimeoutScheduler`, `runtime: RuntimeTurnRunner(runtime)`, `sender: OutboundSender(OutboundPipeline)`) and runs the shared pipeline. One webhook → loop `events.messages`, **serial per threadId** (REQ-3), then `events.statuses/reactions/errors` through their phase handlers.

### 5.2 Durable-Object topology (align with Cloudflare `agents` — REQ-3,4)
The Worker still does signature-verify + `idFromName` fan-out (unchanged). Inside the per-user DO, **build ON Cloudflare's `agents` primitives — do not fight the platform (REQ-12):**
- **Adopt, don't wrap-and-duplicate.** Per the review's `gh` cross-check of `cloudflare/agents`: serial **`TurnQueue`** (`packages/agents/src/chat/turn-queue.ts`), **`messageConcurrency`** merge/debounce (`packages/ai-chat/src/index.ts:573`), **SQLite schedule rows + single multiplexed alarm** via `_scheduleNextAlarm`/`this.schedule()` (`packages/agents/src/index.ts:1742`,`:6040`), and the message-persistence table (`ai-chat:737`). Use these directly. If `messageConcurrency` already provides burst merge/debounce, the DO has **no** `CoalesceScheduler` — coalescing is delegated to CF. The `InboundLedger` is a DO-SQLite sibling table to `SqlSessionStore`. Where `@kuralle-agents/cf-agent` currently hand-rolls something CF provides, **delete ours and adopt theirs** (breaking changes expected and welcome).
- The implementer MUST ground every reuse against a **fresh** `gh repo clone cloudflare/agents` (cited paths/line numbers may drift) and record, in the RFC §10, exactly which CF symbols are adopted vs which thin shims (if any) remain and why.
- The DO's `fetch('/inbound')` calls `pipeline.ingest`; `alarm()` calls `pipeline.flush`; `/wa-resume` appends a `signal` event → `deliverSignal`.

### 5.3 Web chat (REQ-10 — untouched)
`routeAgentRequest` + `KuralleAgent.onChatMessage` + `/get-messages` + the `public/index.html` client are NOT routed through this pipeline. They keep using the AIChatAgent realtime path. The only shared dependency is `createRuntime`/agent/session — unchanged. A regression test (WS chat round-trip + `/get-messages`) gates every stage.

### 5.4 Durable checkout (REQ-7)
`runTurn` may return `{ suspended: { signalId } }` (checkout parked). The `/pay` (Node) and `/wa-pay` (DO) routes append a `signal` event; the pipeline claims it (ledger, so a double-click is a `duplicate`) and calls `deliverSignal`. Exactly-once is enforced twice over: ledger claim on the signal + the runtime effect log (`session.durableRuns`, already persisted by `SqlSessionStore`).

## 6. Migration (staged; breaking changes embraced — REQ-11)

1. **Core extraction (no behavior change):** lift the `createMessagingRouter` `onMessage` body into the shared pipeline + middleware; `createMessagingRouter` becomes a facade. `MessageDeduplicator.isDuplicate` (sync) → `InboundLedger.claim` (async, atomic) — breaking internal API, single call site. All existing `kuralle-messaging` tests must stay green (compat matrix).
2. **DO adapter set:** implement DO-SQLite `InboundLedger`, key-scoped window/consent/ownership stores, and the CF-`agents`-backed `CoalesceScheduler`. New code; proven SQLite pattern from `SqlSessionStore`.
3. **App migration (breaking):** delete `wa-turn.ts` hand-rolled logic; `wa-agent.ts` builds an `InboundRuntime` + the shared pipeline. The DO gains dedup/window/consent/ownership/coalescing it lacked. `toWhatsAppText` moves into an outbound responseMapper (channel formatting), not inbound.
4. **Web-chat regression gate** runs at every stage (REQ-10).
5. Land with coalescing in **shadow** (claim+ledger+ordering on, debounce window = 0) to prove Node↔DO parity, then enable the debounce window per topology.

## 7. Migration / breaking-change matrix (fill during impl — REQ-9/11)

Record the breaking deltas and the in-repo consumers migrated for each. `createMessagingRouter`'s config MAY change; this table is the migration note, not a compat promise.

| Surface | Change | In-repo consumers to migrate |
|---|---|---|
| `createMessagingRouter` config | re-homed onto typed `InboundRuntime` ports; signature may change | `examples/whatsapp-server`, `kuralle-platform` ingress, messaging tests |
| `MessageDeduplicator.isDuplicate` (sync) | → `InboundLedger.claim` (async, atomic) | all call sites |
| coalescing timer injection | host/scheduler-owned (DO: CF `schedule`) | coalescer tests (fake scheduler, not fake timer) |
| app DO path (`wa-turn.ts`) | deleted; runs on shared pipeline | `pharmacy-rx-agent` |

## 8. Validation & adversarial tests (REQ-1..8, R-09)

Must exist before "done":
- Duplicate Meta retry (same `messages[].id`) → exactly one turn, one reply (Node + DO).
- Two `/wa-pay` clicks → one order confirmation.
- Retry during a paused checkout → no double turn, signal still resumes.
- 5-message burst → one coalesced turn (DO) / one merged turn (Node).
- Same-webhook, same-thread two messages → deterministic ordering.
- DO eviction before flush → replay produces exactly one turn (REQ-2).
- Node two-replica duplicate claim → one wins (Redis ledger).
- Two `phoneNumberId`s, same `from` → isolated state (REQ-6).
- **Web-chat regression:** WS `cf_agent_use_chat_request` round-trip + `/get-messages` still work (REQ-10).
- `kuralle-messaging` + `kuralle-messaging-meta` suites pass after migration to the new API (REQ-9) — tests are updated to the new shape, not frozen to the old one.

## 9. WBS

Adopt R-01…R-09 from `.handoff/wbs-wa-pipeline-design-review.md` as the build WBS, plus:
- M-01 Core pipeline + middleware + InboundLedger interface in `kuralle-messaging`; `createMessagingRouter` → facade. Gate: all existing messaging tests green + new dedup/ordering tests.
- M-02 DO adapter set (DO-SQLite ledger/stores + CF-`agents`-backed scheduler) in `cf-agent`. Gate: DO parity tests.
- M-03 Migrate `pharmacy-rx-agent` DO path onto the pipeline; delete `wa-turn.ts`. Gate: WhatsApp live smoke + web-chat regression green.
- M-04 Coalescing enable per topology + adversarial test suite (§8).

## 10. Open questions / decisions
- **DECIDED (REQ-12):** prefer Cloudflare's `agents` primitives over our own. The DO uses CF's `messageConcurrency`/`TurnQueue`/`schedule` directly; we only keep a shim where CF genuinely lacks a capability, and the impl records each adopt-vs-shim decision here. Default = adopt.
- Should the web chat *eventually* become a first-class channel through this pipeline (a `WebChannel` adapter), or stay on AIChatAgent permanently? (Out of scope now; design must not preclude it.)
- Redis `InboundLedger` atomicity: Lua script vs `SET NX` + status key — pick during M-01.

## 11. Rollback
Each stage is independent and behind the facade; if M-02/M-03 regress, revert the app DO path to the current hand-rolled version (kept until M-03 proves out). Web chat is never touched, so it is never at risk.
