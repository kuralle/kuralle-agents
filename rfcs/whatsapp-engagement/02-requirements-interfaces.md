---
rfc: whatsapp-engagement
part: 02-requirements-interfaces
---

## 3. Strict Requirements

Window safety
- **REQ-1:** A free-form (text/media/non-template) message MUST NOT reach the platform when the window is closed. The send path either converts to an APPROVED template or returns a `deferred` outcome; it never emits free-form text outside the window.
- **REQ-2:** The window is tracked per `threadId` from the last inbound timestamp and corrected by platform-reported `expiration_timestamp` (status webhooks). Window enforcement is **on by default** — it cannot be silently bypassed by an author who does nothing.
- **REQ-3:** Every outbound produces an observable, discriminated `SendOutcome` (`sent` | `converted` | `deferred` | `suppressed`); no silent drops.

Smart send strategist
- **REQ-4:** A single strategist decides `freeform | template | defer` from (requested message, window state, template catalog, session/flow context). It is used BOTH as the default automatic guard and via an explicit `smartSend` flow node, sharing one implementation.
- **REQ-5:** Template selection is performed by an injectable, mockable `TemplateSelector` (the only non-deterministic seam). Deterministic guardrails run OUTSIDE the AI: (a) the selector only ever receives APPROVED, non-paused templates; (b) selected parameters are validated against the template's declared params; (c) a failure (no fit / invalid params) yields `defer`, never a malformed send; (d) every conversion writes an audit record before the send.
- **REQ-6:** Window-open sends are returned as `freeform` with NO `TemplateSelector` call (cost + determinism + latency).

Interactive fidelity
- **REQ-7:** A flow `collect`/`decide` node MAY declare choice options; the engine renders them to the correct WhatsApp interactive type by size (buttons ≤3, list ≤10 rows) or kind (cta, Flow), enforcing platform limits (labels, row counts).
- **REQ-8:** Inbound `interactive.button_reply`, `interactive.list_reply`, top-level template `button` (payload), and `interactive.nfm_reply` (Flow submission) MUST resolve to a stable id (and, for Flows, parsed form data) that drives flow routing — independent of display label/language. Free-text inbound falls back to NLU.
- **REQ-9:** Interactive declaration and inbound resolution MUST be additive to `@kuralle-agents/core` (no breaking change to the `FlowNode` union or `runFlow` exhaustive switches).

Human handoff
- **REQ-10:** `escalate`/handoff sets a persisted human-ownership flag for the conversation. While owned, the bot emits zero outbound (`suppressed`) and inbound is recorded (not auto-answered). Releasing ownership resumes the paused flow.

Consent
- **REQ-11:** No outbound (reactive or proactive) is sent unless the customer is opted in. Opt-out (`STOP`) is honored immediately, persisted, and halts active drips/broadcasts for that customer.

Proactive outbound
- **REQ-12:** Broadcasts send an approved template to a set of opted-in recipients; a reply hands the customer into a flow. Sends are idempotent under retry via an explicit **`BroadcastLedger`** keyed by `(campaign, customer)` — NOT the per-run effect log (which dedupes only within a conversation, since `runId == sessionId`); see §4.7/§6.5 (R-07).
- **REQ-13:** Drips/sequences support per-step delays and stop-on-reply. Re-engagement after the window sends an approved template that reopens the window and resumes the customer's flow.

Foundation
- **REQ-14:** Everything runs on one Kuralle runtime alongside other channels, preserving Kuralle's durable run/replay, exactly-once execution, and resumable sessions. The generic bridge stays channel-agnostic (templates are a WhatsApp capability, capability-detected).
- **REQ-15:** Per-conversation/customer state (ownership, consent, campaign membership) persists in the `SessionStore`. The messaging window is backed by a **pluggable `WindowStore`** (REQ-18).

Amendments from adversarial review (R-01..R-10 — see [§12 Revision notes](./05-security-rollback-open-qs.md#revision-notes-adversarial-review)):
- **REQ-16 (R-01):** Window enforcement applies to **every non-template outbound payload** — `text`, `media`, AND `interactive` — not text alone. Templates are the only window-agnostic payload. (Interactive/media are free-form and rejected by Meta outside the window.)
- **REQ-17 (R-02):** **Every** outbound MUST traverse the `OutboundPipeline`. No code path may call a platform client's send method directly outside the sink — this explicitly includes the router's `fallbackMessage` send (today `createMessagingRouter.ts:81`) and any custom `responseMapper` (today handed raw send closures, `stream-mapper.ts:82-89`). The custom `responseMapper` contract is reshaped to emit `OutboundPayload`s into the pipeline, never to call the client. The public `WhatsAppClient.sendTextOrTemplate` (`client.ts:287-294`) is also a direct-send bypass — deprecate it / wrap it behind the `OutboundSink` so no caller can emit outside the pipeline (R-02-S).
- **REQ-18 (R-06):** The window is read/written through a `WindowStore` interface. The default in-memory impl is for single-process/dev; a durable shared store is REQUIRED for multi-process/serverless (mirrors the `SessionStore` stance). On an unknown window (cold process, store miss) the policy MUST fail closed (treat as closed → strategist), never fail open.
- **REQ-19 (R-05):** A **customer identity** (the WhatsApp `wa_id`/phone) is modeled distinctly from `sessionId` and `threadId`. Consent and campaign membership are keyed by **customer identity**; ownership and window by **conversation**. The default session resolver MUST NOT double-prefix the platform (no `whatsapp:whatsapp:` — today `session-resolver.ts:14` + `client.ts:592` produce that).
- **REQ-20 (R-03/R-04):** Structured inbound selections (button/list `id`, template `button.payload`, Flow `nfm_reply` form data) MUST be propagated into flow state via a defined runtime mechanism (`RunOptions.selection`, §4.8), not only the `input` string. The normalized `InboundMessage` MUST first be extended with `button` and `interactive.formResponse` (§4.10).
- **REQ-21 (R-08):** Handing off to a human MUST NOT route through the agent-switch handoff path (`runFlow.ts:161` → `Runtime.ts:172-181` throws on a missing agent). It sets conversation ownership = `human` via a dedicated transition, and an **inbound ownership gate** suppresses running the flow (no side effects) while human-owned — outbound suppression alone is insufficient because the runtime executes on inbound.
- **REQ-22 (rev3 — omnichannel):** Engagement logic is **channel-agnostic**. All channel differences (window model, closed-window recovery, interactive rendering, consent requirement, inbound mapping) are isolated behind an injected **`ChannelPolicy`** (§4.12). The package is `@kuralle-agents/engagement`; WhatsApp, Web, and Instagram ship as `ChannelPolicy` adapters; the same Kuralle agents/flows run unchanged across all channels. Adding a channel = one new policy, zero engine/bot changes. The smart-send strategist (§4.4) is the WhatsApp policy's `ClosedWindowStrategy`, not the engine.
- **REQ-23 (rev4, R-08-B):** `Runtime` supports **terminal handoff targets** (default `['human']`, configurable). A handoff to a terminal target pauses the run and emits a `handoff` stream part instead of resolving an agent — eliminating the `Runtime.ts:178-180` missing-agent throw on `escalate→'human'`. This is an additive `HarnessConfig`/`RunOptions` field; non-terminal handoffs behave exactly as today.

## 4. Interface Specification

Conventions: `messaging` = `@kuralle-agents/messaging`; `core` = `@kuralle-agents/core`; `engagement` = new **`@kuralle-agents/engagement`** (dir `packages/kuralle-engagement/`; channel-agnostic — rev3/rev4, REQ-22). Signatures are the public surface; bodies are in §7.

### 4.1 Outbound pipeline (core fix, `messaging`)
- **Location:** `packages/kuralle-messaging/src/adapter/outbound-pipeline.ts`, `types/outbound.ts`
- **Signatures:**
  - `interface OutboundMiddleware { readonly name: string; send(req: OutboundRequest, next: OutboundNext): Promise<SendOutcome> }`
  - `type OutboundNext = (req: OutboundRequest) => Promise<SendOutcome>`
  - `interface OutboundRequest { threadId: string; platform: string; payload: OutboundPayload; meta: OutboundMeta }`
  - `type OutboundPayload = { kind:'text'; text:string } | { kind:'interactive'; interactive: InteractiveMessage } | { kind:'media'; media: MediaPayload } | { kind:'template'; template: OutboundTemplate }`
  - `interface OutboundMeta { window: WindowState; parts: HarnessStreamPart[]; sessionId: string; userId?: string }`
  - `type WindowState = { open:true; expiresAt: Date } | { open:false; expiresAt: Date | null }`  *(value type from [fn-B])*
  - `type SendOutcome = { kind:'sent'; result: SendResult } | { kind:'converted'; result: SendResult; template: string; from: string } | { kind:'deferred'; reason: DeferReason } | { kind:'suppressed'; reason: string }`
  - `class OutboundPipeline { constructor(mw: OutboundMiddleware[], sink: OutboundSink); send(req: OutboundRequest): Promise<SendOutcome> }`
- **Behavior:** ordered chain terminating in `OutboundSink`. `createMessagingRouter` installs a **default chain** `[consentGate, ownershipGate, windowGuard]` (engagement adds `strategist`, `interactiveRenderer`). The `windowGuard` is **non-removable**: if absent from a supplied chain the router throws at construction (REQ-2).
- **Error cases:** a middleware throwing aborts the send and surfaces via `onError`; `windowGuard` never forwards a `{kind:'text'}` payload downstream when `meta.window.open === false`.

### 4.2 Platform template capability (core fix, `messaging`)
- **Location:** `types/client.ts`, `types/outbound.ts`
- **Signatures:**
  - `interface OutboundSink { sendText(to,text): Promise<SendResult>; sendInteractive(to,msg): Promise<SendResult>; sendMedia(to,media): Promise<SendResult>; sendTemplate?(to, t: OutboundTemplate): Promise<SendResult> }`
  - `interface OutboundTemplate { name: string; language: string; components?: TemplateComponent[]; namedParams?: Record<string,string>; positionalParams?: string[]; raw?: unknown }`  *(component-aware — mirrors `whatsapp/types.ts:110` `TemplateComponent`; supports BOTH named and positional params per Meta, not a flat `Record<string,string>`. R-10.)*
  - `function isTemplateCapable(c: PlatformClient): c is PlatformClient & { sendTemplate(...): Promise<SendResult> }`
- **Behavior:** the generic bridge references templates only through this capability-detected optional method — no WhatsApp type leaks into `messaging`. `WhatsAppClient` already satisfies it.

### 4.3 Inbound resolver chain (core fix, `messaging`)
- **Location:** `adapter/input-resolver-chain.ts`
- **Signatures:**
  - `interface InboundResolverPlugin { readonly name: string; tryResolve(m: InboundMessage): Promise<{ input: string; selection?: ResolvedSelection } | undefined> }`
  - `class InboundResolverChain { constructor(plugins: InboundResolverPlugin[]); resolve(m: InboundMessage): Promise<{ input: string; selection?: ResolvedSelection }> }`  *(first-match-wins, mirrors `SessionResolverChain`)*
  - `type ResolvedSelection = { id?: string; formData?: Record<string, unknown> }`
  - default chain: `[new InteractiveResolver(), new TextResolver()]`
- **Behavior:** replaces the `createMessagingRouter.ts:66` text-only derivation. `InteractiveResolver` maps `button_reply`/`list_reply`→`id`, template `button.payload`→`id`, `nfm_reply.response_json`→`formData`; `TextResolver` returns `message.text`. `MessagingRouterConfig` gains `inputResolver?: InboundResolverPlugin[]`.
- **Error cases:** empty chain throws; no-match throws (no silent `[type]` fallback) — `TextResolver` is the catch-all.

### 4.4 Smart-send strategist (`engagement`)
- **Location:** `packages/kuralle-messaging-engagement/src/strategist.ts` (package dir `kuralle-whatsapp-engagement`)
- **Signatures:**
  - `interface SmartSendStrategist { decide(input: StrategistInput): Promise<SendDecision> }`
  - `type SendDecision = { kind:'freeform'; text:string } | { kind:'template'; template: OutboundTemplate; selected: TemplateDescriptor; audit: ConversionAudit } | { kind:'defer'; reason: DeferReason }`
  - `interface TemplateSelector { select(in: { text:string; intent?:string; candidates: readonly TemplateDescriptor[]; flowState?: Readonly<Record<string,unknown>> }): Promise<{ name:string; language:string; params: Record<string,string> } | null> }`
  - `interface TemplateCatalog { approved(): Promise<TemplateDescriptor[]>; validateParams(name:string, p:Record<string,string>): { ok:boolean; errors?:string[] } }`
  - `interface TemplateDescriptor { name; language; category:'authentication'|'marketing'|'utility'; status:'APPROVED'|'PENDING'|'REJECTED'; quality:'GREEN'|'YELLOW'|'RED'|'PAUSED'|'DISABLED'|'UNKNOWN'; params: { key:string; required:boolean }[] }`
  - `interface AuditSink { record(a: ConversionAudit): Promise<void> | void }`
  - `function createSmartSendStrategist(opts: { catalog: TemplateCatalog; selector: TemplateSelector; audit: AuditSink }): SmartSendStrategist`
  - `function strategistMiddleware(s: SmartSendStrategist): OutboundMiddleware`
- **Behavior:** window-open → `{freeform}` (no selector call, REQ-6). Closed → `catalog.approved()` filter → `selector.select(candidates)` → `catalog.validateParams` → audit → `{template}`; any failure → `{defer}`.
- **Error cases:** selector timeout/throw → `defer` (never block the send path); validation failure → `defer`.

### 4.5 Author surface (`engagement`, from [fn-A])
- **Signatures:**
  - `interface ChoiceOption { id: string; label: string; description?: string; url?: string; flow?: { flowId: string; cta: string } }`
  - `function withChoices<N extends CollectNode | DecideNode>(node: N, options: ChoiceOption[]): N`  *(attaches options as node metadata; the runtime echoes them as the new stream part)*
  - `function smartSend(node: { id: string; message: (s: FlowState)=>string; intent?: string; next?: (d: SendDecision, s: FlowState)=>Transition }): ActionNode`  *(an `action` node invoking the shared strategist — no new FlowNode kind, REQ-9)*
  - `function engagement(opts: { policies: ChannelPolicy[]; consent?: ConsentStore; ownership?: OwnershipStore; audit?: AuditSink; scheduler?: Scheduler }): { bridge: Pick<MessagingRouterConfig,'outbound'|'inputResolver'|'onStatus'>; broadcasts: BroadcastApi }`  *(channel-agnostic — rev3)*
  - `function whatsappPolicy(opts: { client: WhatsAppClient; selector: TemplateSelector }): ChannelPolicy` · `function webPolicy(): ChannelPolicy` · `function instagramPolicy(opts: { client: InstagramClient }): ChannelPolicy`  *(per-channel adapters, §4.12)*
- **Behavior:** `engagement({ policies: [whatsappPolicy(...), webPolicy(), instagramPolicy(...)] })` is the single wiring call; `.bridge` spreads into `createMessagingRouter`. The pipeline/gates/broadcast are channel-agnostic; each policy supplies its channel's window model, closed-window strategy, interactive renderer, and inbound mapping. The author's flows/agents are unchanged across channels.

### 4.6 Interactive stream part (core, additive — Q3)
- **Location:** `packages/kuralle-core/src/types/stream.ts`
- **Signature:** add one variant: `| { type: 'interactive'; nodeId: string; options: ChoiceOption[]; prompt: string }`
- **Behavior:** emitted by `collect`/`decide` on node entry when `withChoices` metadata is present; the `interactiveRenderer` middleware consumes it. Additive — existing consumers ignore unknown variants.

### 4.7 Ownership / consent / scheduler (`engagement`)
- `interface OwnershipStore { owner(threadId): Promise<'bot'|'human'>; claim(threadId, by): Promise<void>; release(threadId): Promise<void> }` (default impl: `SessionStore`-backed, keyed by conversation)
- `interface ConsentStore { isOptedIn(customerId): Promise<boolean>; optOut(customerId): Promise<void>; optIn(customerId): Promise<void> }` (default: `SessionStore`-backed; **keyed by `customerId`, not thread — REQ-19**)
- `interface Scheduler { enqueue(job: SendJob, opts: { delayMs?: number }): Promise<string>; cancel(jobId): Promise<void> }` with a default in-process impl + documented production adapters (Q6).
- `interface BroadcastLedger { putIfAbsent(key: string /* `${campaignId}:${customerId}` */): Promise<boolean> }` (R-07) — atomic compare-and-set; returns `false` if already present (skip). `SessionStore`/durable-backed so idempotency holds across processes, independent of the per-run effect log.
- `ownershipGate` / `consentGate`: `OutboundMiddleware` that short-circuit to `suppressed`/`deferred`.

### 4.8 Runtime selection propagation (core, additive — R-03/REQ-20)
- **Location:** `packages/kuralle-core/src/runtime/Runtime.ts` (`RunOptions`), `runtime/openRun.ts`
- **Signatures:** `interface RunOptions { /* existing */ input?: string; selection?: ResolvedSelection }`
- **Behavior:** additive optional field. At turn start the runtime merges `selection.formData` into the run's flow state and exposes `selection.id` as the routing value (`input`). Today `RunOptions` carries only `input?: string` (`Runtime.ts:51`; `openRun.ts:77-92` queues a string) — this is the concrete propagation mechanism, replacing the RFC's earlier "merged via run-context" hand-wave.
- **Error cases:** absent `selection` → behave exactly as today (string `input`).

### 4.9 WindowStore (core fix — R-06/REQ-18)
- **Location:** `packages/kuralle-messaging/src/adapter/window-store.ts`
- **Signatures:** `interface WindowStore { get(threadId): Promise<WindowState>; recordInbound(threadId, ts: Date): Promise<void>; recordExpiry(threadId, at: Date): Promise<void> }`; default `InMemoryWindowStore` (wraps today's `WindowTracker`); `MessagingRouterConfig.windowStore?`.
- **Behavior:** the `windowGuard` reads `WindowStore.get`. Durable adapters (Redis/Postgres) enable multi-process. **Fail closed:** an unknown/missing window resolves to `{ open: false }` so a cold process never leaks.

### 4.10 Inbound type extensions (core fix — R-04/REQ-20)
- **Location:** `packages/kuralle-messaging/src/types/messages.ts`, `packages/kuralle-messaging-meta/src/whatsapp/client.ts`
- **Signatures:** `InboundMessage` gains `button?: { payload: string; text: string }` and `interactive.formResponse?: Record<string, unknown>`, plus `customerId: string` (the wa_id/phone, distinct from `threadId`).
- **Behavior:** WhatsApp `toInboundMessage` populates `button` from the top-level template `button`, `interactive.formResponse` from the parsed `nfm_reply.response_json` (today dropped — `client.ts:609-620`), and `customerId` from `msg.from`. The `InteractiveResolver` (§4.3) reads these fields (the earlier §4.3 sketch referenced fields that did not yet exist — this chunk adds them first).

### 4.11 Customer identity + inbound ownership gate (R-05/R-08/REQ-19/REQ-21)
- **Default session resolver:** `sessionId = message.threadId` (NO extra `${platform}:` prefix — WhatsApp `threadId` is already `whatsapp:{phoneNumberId}:{from}`; double-prefixing produced `whatsapp:whatsapp:...`). `userId = customerId`.
- **Inbound ownership gate** in `createMessagingRouter`: if `ownership.owner(threadId) === 'human'`, record the inbound message into history and **do NOT call `runtime.run`** (no flow side effects fire while human-owned). Resume requires an explicit `ownership.release`.
- **Handoff-to-human seam (R-08-B, rev4):** a flow `escalate`/`{ handoff:'human' }` is intercepted **before** `Runtime` resolves it as an agent (`runFlow.ts:161-163` → `Runtime.ts:178-180` throws on a missing `'human'` agent). Concrete mechanism (REQ-23): `Runtime` gains a configured set of **terminal handoff targets** (default `['human']`) — a handoff to a terminal target **pauses the run and emits a `handoff` stream part** instead of switching agents. The engagement `ownershipGate` consumes that emitted handoff to `ownership.claim(threadId,'human')`. Authors may also use the engagement-provided **`humanHandoff()` action node** (sets ownership + ends the turn) to avoid the `escalate` path entirely. Either way, no missing-agent throw.

### 4.12 ChannelPolicy — the omnichannel seam (rev3, REQ-22)
The engagement layer is channel-agnostic; each channel injects one `ChannelPolicy`. The `windowGuard` calls `policy.isWindowOpen`; on a closed window it applies `policy.closedWindow`; the `interactiveRenderer` calls `policy.renderInteractive`; the inbound chain uses `policy.resolveInbound`.

- **Location:** `packages/kuralle-engagement/src/policy.ts` (interface); adapters in `messaging-meta` (WhatsApp, Instagram) and `engagement` (web).
- **Signatures:**
  - `interface ChannelPolicy { readonly channel: string; readonly hasWindow: boolean; isWindowOpen(threadId): Promise<boolean>; readonly closedWindow: ClosedWindowStrategy; readonly consentRequired: boolean; renderInteractive(options: ChoiceOption[], prompt: string): InteractiveMessage; resolveInbound(m: InboundMessage): { input: string; selection?: ResolvedSelection } }`
  - `type ClosedWindowStrategy = { kind: 'template'; strategist: SmartSendStrategist } | { kind: 'message-tag'; tag: string } | { kind: 'none' }`
- **The three adapters this cut:**
  - **WhatsApp** — `hasWindow: true`; `isWindowOpen` ← `WindowStore`; `closedWindow: { kind:'template', strategist }` (the §4.4 strategist + AI `TemplateSelector`); `consentRequired: true`; `renderInteractive` → reply buttons(≤3)/list(≤10)/cta/Flows; `resolveInbound` → `button_reply`/`list_reply`/template `button`/`nfm_reply` → id/formData.
  - **Web/SSE** — `hasWindow: false`; `isWindowOpen` → always `true`; `closedWindow: { kind:'none' }`; `consentRequired: false`; `renderInteractive` → the web UI's button/list elements; `resolveInbound` → text (UI may pass an explicit `selection`). A near-empty "null policy" that proves the abstraction for free.
  - **Instagram** — `hasWindow: true` (24h); `closedWindow: { kind:'message-tag', tag:'HUMAN_AGENT' }`. **(IG-CW, rev4)** the IG client only exposes `sendTextWithTag` (`instagram/client.ts:423-438`) — a tag can wrap **text only**; an interactive/media payload outside the window CANNOT be tagged → it **defers** (the message-tag strategy applies to `kind:'text'`, else `deferred`). `consentRequired: true`. `renderInteractive` → buttons map to the IG **button template** (`sendButtonTemplate`, `client.ts:186-195`) or **quick replies** (`sendQuickReplies` ≤13, `client.ts:299-316`); carousels → `sendGenericTemplate` (`client.ts:323-344`); NO WhatsApp list/Flows. `resolveInbound` → quick-reply/postback payload → id. (Proactive re-engagement is constrained: no template-approval system — see RESEARCH §6; Q7.)
- **Behavior:** a policy is the ONLY channel-specific code. Adding Messenger (or RCS/Telegram/SMS later) = one new `ChannelPolicy`, no change to the engine or the bot.
- **Error cases:** `closedWindow.kind === 'none'` on a closed window with a free-form send → `deferred` (web never hits this; Instagram defers when no handoff tag applies).

## 5. Architecture and System Dependencies

### 5.1 Structural changes
- **New package** `@kuralle-agents/whatsapp-engagement` (`packages/kuralle-whatsapp-engagement/`): strategist, gates (consent/ownership/window-aware bits), interactive renderer, inbound interactive resolver, proactive engine (broadcasts/drips), `whatsappEngagement()` wiring, `SessionStore`-backed `OwnershipStore`/`ConsentStore`, default `Scheduler`.
- **Modified** `@kuralle-agents/messaging`: introduce `OutboundPipeline` + `InboundResolverChain`; `createMessagingRouter` installs the default outbound chain (with non-removable `windowGuard`) and the default inbound chain; `StreamMapper` becomes a thin driver over the pipeline; add `OutboundSink`/`OutboundTemplate`/capability detection.
- **Modified** `@kuralle-agents/core`: one additive `HarnessStreamPart` variant (`interactive`); `collect`/`decide` carry optional choice metadata (additive field). No `FlowNode` union change.
- **Modified** `@kuralle-agents/messaging-meta`: WhatsApp client `toInboundMessage` extracts `nfm_reply.response_json`; expose template catalog (status/quality) for the strategist.
- **Example** `packages/kuralle-messaging-meta/examples/multi-platform`: demonstrate window-safety, buttons/list, handoff, and a broadcast-to-flow.

### 5.2 Service & library dependencies
WhatsApp Cloud API (Meta) via the existing `WhatsAppClient`. AI `TemplateSelector` via an injected Vercel AI SDK model (provider-agnostic; mockable). No new vendor.

### 5.3 Data & schema changes
Two identity scopes (R-05): **conversation** (`threadId` = `sessionId`) and **customer** (`customerId` = wa_id/phone). New `SessionStore`-resident state: `ownership: 'bot'|'human'` (conversation-keyed), `consent: { optedIn; optedOutAt? }` and `campaign: { id; step; stoppedOnReply? }` (**customer-keyed**), and a `BroadcastLedger` entry per `(campaignId, customerId)` for proactive idempotency (R-07). Window state moves behind the pluggable `WindowStore` (§4.9): in-memory default, durable adapter for multi-process (R-06). No DB migration in core (backends serialize blobs; durable WindowStore/BroadcastLedger may add a keyspace).

### 5.4 Network & performance
Strategist adds an AI call ONLY on closed-window sends (REQ-6); `catalog.approved()` is cached behind the catalog so in-window replies make no network call. Selector has a timeout → `defer`. Per-message pipeline traversal is O(middleware count), all in-process.
