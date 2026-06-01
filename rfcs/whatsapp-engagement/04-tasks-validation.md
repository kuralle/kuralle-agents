---
rfc: whatsapp-engagement
part: 04-tasks-validation
---

## 8. Incremental Task Breakdown

Order: **core seams first** (the runtime/transport extensions the layer depends on), then **safety core** (window → strategist → interactive → handoff), then **proactive outbound**. Each chunk is independently committable and testable offline with the fake-client pattern (no live Meta API). Chunks tagged **(R-NN)** address adversarial-review findings.

**Phase A0 — Core seams (prerequisites surfaced by review)**
- [ ] **A0.1 Inbound types + customer identity (R-04/R-05)** — add `button?: {payload,text}`, `interactive.formResponse?`, and `customerId: string` to `InboundMessage`; WhatsApp `toInboundMessage` populates them and parses `nfm_reply.response_json`; default session resolver returns `sessionId = threadId` (no `whatsapp:whatsapp:` double-prefix), `userId = customerId`. Files: `messaging/src/types/messages.ts`, `messaging/src/adapter/session-resolver.ts`, `messaging-meta/src/whatsapp/client.ts`.
- [ ] **A0.2 RunOptions.selection propagation (R-03)** — additive `selection?: ResolvedSelection` on `RunOptions`; runtime merges `selection.formData` into flow state at turn start and exposes `selection.id` as `input`. Files: `core/src/runtime/{Runtime.ts,openRun.ts,ctx.ts}`.
- [ ] **A0.3 WindowStore abstraction (R-06)** — extract a `WindowStore` interface; `InMemoryWindowStore` wraps the current `WindowTracker`; `createMessagingRouter` reads via `WindowStore`; unknown window → `{open:false}` (fail closed). Files: `messaging/src/adapter/{window-store,window-tracker,createMessagingRouter}.ts`.
- [ ] **A0.5 Terminal handoff targets (rev4, R-08-B/REQ-23)** — `Runtime` treats configured terminal handoff targets (default `['human']`) as pause-the-run + emit a `handoff` stream part, instead of resolving an agent (avoids the `Runtime.ts:178-180` missing-agent throw on `escalate→'human'`). Additive `HarnessConfig` field. Files: `core/src/runtime/Runtime.ts`.
- [ ] **A0.4 ChannelPolicy abstraction + Web null policy (rev3, REQ-22)** — define `ChannelPolicy`/`ClosedWindowStrategy` (§4.12); make `windowGuard`/`interactiveRenderer`/inbound chain read the injected policy; ship `webPolicy()` (`hasWindow:false`, `consentRequired:false`, `closedWindow:{kind:'none'}`) — the trivial adapter that proves the abstraction. Files: `kuralle-engagement/src/{policy,policies/web}.ts`.

**Phase A — Window safety core (correct-by-default)**
- [ ] **A1. OutboundSink + capability detection** — add `OutboundSink`, `OutboundTemplate`, `isTemplateCapable`; `WhatsAppClient` satisfies `sendTemplate`. Files: `messaging/src/types/{client,outbound}.ts`, `messaging-meta/src/whatsapp/client.ts`.
- [ ] **A2. OutboundPipeline + middleware contract** — `OutboundMiddleware`/`OutboundRequest`/`SendOutcome`/`WindowState`; `OutboundPipeline` with the non-removable `window-guard` assertion. Files: `messaging/src/adapter/outbound-pipeline.ts`, `types/outbound.ts`.
- [ ] **A3. windowGuard middleware + wire into router (R-01/R-02)** — `windowGuard` gates EVERY non-template payload (text/media/interactive), reading `WindowStore`. `StreamMapper` feeds parts to the pipeline; `createMessagingRouter` installs `[consentGate, ownershipGate, windowGuard]`. **Close the bypasses:** route the router `fallbackMessage` and any custom `responseMapper` through the pipeline (reshape the `responseMapper` contract to emit `OutboundPayload`s, not raw client closures). Constructor enforces the guard is present AND terminal (R-09). Files: `adapter/{stream-mapper,createMessagingRouter,outbound-pipeline,middleware/window-guard}.ts`, `types/adapter.ts`.

**Phase B — Smart-send strategist**
- [ ] **B1. Strategist module + guardrails** — `SmartSendStrategist`, `TemplateCatalog`, `TemplateDescriptor`, `AuditSink`, `createSmartSendStrategist` (§6.2). Files: `whatsapp-engagement/src/strategist.ts`.
- [ ] **B2. TemplateSelector seam + WhatsApp catalog (R-10)** — `TemplateSelector` interface; an AI selector impl (Vercel AI SDK); a `TemplateCatalog` backed by the WhatsApp templates API filtering to APPROVED + non-paused (the WhatsApp `TemplateInfo` at `whatsapp/types.ts:367` lacks quality/paused — extend it). `OutboundTemplate` is **component-aware** (named + positional + components, mirroring `whatsapp/types.ts:110`), not `Record<string,string>`. Files: `whatsapp-engagement/src/{selector,catalog}.ts`, `messaging-meta/src/whatsapp/{types,templates}.ts`.
- [ ] **B3. strategistMiddleware + smartSend node** — wire the strategist as the middleware `windowGuard` hands off to, and as the `smartSend` action node (shared instance). Files: `whatsapp-engagement/src/{strategist-middleware,nodes}.ts`.

**Phase C — Interactive fidelity**
- [ ] **C1. Core stream part + choice metadata** — additive `{type:'interactive'}` `HarnessStreamPart`; optional choice metadata on `collect`/`decide`; emit on node entry. Files: `core/src/types/stream.ts`, `core/src/flow/{nodeKinds,runFlow}.ts` (additive emit only).
- [ ] **C2. interactiveRenderer middleware (R-11)** — render `ChoiceOption[]`→buttons/list/cta/flow and **validate platform limits in the renderer** (≤3 buttons, ≤10 list rows, label lengths) — the client silently slices today (`client.ts:340`), which must become an explicit error, not silent truncation. Files: `whatsapp-engagement/src/interactive-renderer.ts`.
- [ ] **C3. Inbound resolver chain + nfm_reply** — `InboundResolverChain`, `InteractiveResolver`, `TextResolver`; `MessagingRouterConfig.inputResolver?`; WhatsApp `toInboundMessage` extracts `nfm_reply.response_json`. Files: `messaging/src/adapter/input-resolver-chain.ts`, `createMessagingRouter.ts`, `messaging-meta/src/whatsapp/client.ts`.
- [ ] **C4. `withChoices` author helper** — attaches metadata; `selection.formData` merged into flow state via run-context. Files: `whatsapp-engagement/src/authoring.ts`.

**Phase D — Human handoff + consent**
- [ ] **D1. OwnershipStore + inbound ownership gate (R-08)** — `SessionStore`-backed `OwnershipStore`; a flow `escalate` to `'human'` becomes `ownership.claim` (NOT an agent-switch handoff — `Runtime.ts:172-181` throws on a missing agent). The router gains an **inbound** ownership gate: while human-owned it records the inbound and does NOT call `runtime.run` (outbound suppression alone is insufficient — the runtime fires side effects on inbound). Release resumes the paused flow. Files: `whatsapp-engagement/src/ownership.ts`, `messaging/src/adapter/createMessagingRouter.ts`.
- [ ] **D2. ConsentStore + consentGate + STOP** — `SessionStore`-backed consent; `STOP` handler opts out; `consentGate` blocks outbound. Files: `whatsapp-engagement/src/consent.ts`.

**Phase E — Proactive outbound**
- [ ] **E1. Scheduler interface + default impl** — `Scheduler` (enqueue/cancel) + in-process default; documented production adapters. Files: `whatsapp-engagement/src/scheduler.ts`.
- [ ] **E2. Broadcast engine (R-07)** — send approved template to opted-in recipients **through the pipeline**; idempotency via an explicit `BroadcastLedger` keyed by `(campaignId, customerId)` with atomic `putIfAbsent` (NOT the per-run effect log — `runId == sessionId`, `openRun.ts:31`, so it dedupes within a conversation only; and `RunOptions` has no `seed`). A reply arrives as normal inbound → the router runs the flow. Files: `whatsapp-engagement/src/{broadcast,broadcast-ledger}.ts`.
- [ ] **E3. Drip/sequence + re-engagement** — per-step delay, stop-on-reply, re-engagement template that reopens the window and resumes the flow. Files: `whatsapp-engagement/src/drip.ts`.

**Phase G — Channel adapters (rev3, REQ-22)**
- [ ] **G1. WhatsApp `ChannelPolicy`** — `whatsappPolicy({ client, selector })`: window via `WindowStore`; `closedWindow:{kind:'template', strategist}` (Phase B); renderer → buttons/list/cta/Flows; inbound → button/list/template-button/nfm_reply. Files: `messaging-meta/src/whatsapp/policy.ts`.
- [ ] **G2. Instagram `ChannelPolicy`** — `instagramPolicy({ client })`: 24h window; `closedWindow:{kind:'message-tag', tag:'HUMAN_AGENT'}`; renderer → quick-replies + generic-template carousels (no list/Flows); inbound → quick-reply/postback payload → id. Document that proactive re-engagement is limited (no template-approval). Files: `messaging-meta/src/instagram/policy.ts` (+ extend `InstagramClient` if a send shape is missing).

**Phase F — Integration & proof**
- [ ] **F1. `engagement()` wiring (channel-agnostic)** — compose the bridge from `{ policies: [...] }`; `.broadcasts` export. Files: `kuralle-engagement/src/index.ts`.
- [ ] **F2. multi-platform example (3 channels)** — `engagement({ policies: [whatsappPolicy(...), webPolicy(), instagramPolicy(...)] })` on the existing example; demonstrate the SAME bot answering on WhatsApp + web + Instagram, window-safety, buttons/list routing by id, handoff ownership, and a broadcast-to-flow (WhatsApp). Files: `messaging-meta/examples/multi-platform/server.ts`.
- [ ] **F3. README + docs guide** — package README + a docs guide page (per the repo's "docs in the same change" rule).

## 9. Validation and Testing

Prior art (offline fake-client style): `packages/kuralle-messaging/test/` (adapter tests, `unhappy-paths.test.ts` — object-literal `PlatformClient` with recording `onSendText`/`onSendInteractive`), `packages/kuralle-messaging-meta/test/` (WhatsApp client), `packages/kuralle-e2e-tests/`. Tests assert observable platform calls and `SendOutcome`s; the AI is the one mocked `TemplateSelector` seam.

### 9.1 Fail-to-Pass tests
- `window_closed_never_sends_freeform` — closed window + a `reply`/text send ⇒ `sink.sendText` call count === 0; outcome is `converted` (sendTemplate) or `deferred`. (REQ-1)
- `window_open_sends_freeform_no_selector_call` — open window ⇒ `sendText` fires and `TemplateSelector` mock call count === 0. (REQ-6)
- `window_guard_required` — constructing a pipeline without `window-guard` throws. (REQ-2)
- `strategist_filters_paused_templates` — a PAUSED/REJECTED template never appears in `selector` candidates. (REQ-5a)
- `strategist_defers_on_bad_params` — selector returns params failing validation ⇒ `defer`, no send, no audit-as-sent. (REQ-5b/c)
- `strategist_audits_conversion` — a `template` decision writes exactly one `ConversionAudit`. (REQ-5d)
- `interactive_routes_by_id_not_label` — `button_reply{id:'x', title:'A'}` and `{id:'x', title:'totally different'}` drive the identical transition. (REQ-8)
- `template_button_payload_routes` — top-level `button.payload` resolves the same id. (REQ-8)
- `nfm_reply_form_in_state` — a Flow submission's `response_json` lands in flow state. (REQ-8)
- `free_text_nlu_fallback` — plain text still routes via `TextResolver`/NLU. (REQ-8)
- `render_picks_buttons_then_list` — 3 options ⇒ buttons; 6 ⇒ list; >10 ⇒ limit error. (REQ-7)
- `human_owned_suppresses_bot` — ownership='human' ⇒ outbound count === 0, inbound recorded; release ⇒ paused flow resumes. (REQ-10)
- `not_opted_in_blocks_send` / `stop_opts_out_and_halts_drip` — consent gate. (REQ-11)
- `broadcast_idempotent_and_reply_enters_flow` — duplicate broadcast send is a no-op; a reply hands into a flow. (REQ-12)
- `drip_stops_on_reply` / `reengagement_reopens_window_and_resumes` — proactive. (REQ-13)

Added from adversarial review:
- `window_closed_blocks_media_and_interactive` — closed window + a media or interactive send ⇒ NOT emitted free-form (converted/deferred); not just text. (R-01/REQ-16)
- `fallback_and_custom_mapper_route_through_pipeline` — the router `fallbackMessage` and a custom `responseMapper` cannot reach the client except via the pipeline; closed-window ⇒ no leak through either. (R-02/REQ-17)
- `selection_formdata_lands_in_flow_state` / `selection_id_is_routing_input` — `RunOptions.selection` propagates into flow state and routing. (R-03/REQ-20)
- `nfm_reply_and_template_button_parsed` — WA `toInboundMessage` populates `interactive.formResponse` and `button.payload`. (R-04)
- `session_id_not_double_prefixed` — resolver yields `whatsapp:{phoneNumberId}:{from}`, not `whatsapp:whatsapp:...`; `consent` keyed by `customerId`. (R-05/REQ-19)
- `window_store_fail_closed` — unknown window (cold store) ⇒ treated as closed (no leak); durable store shares window across two router instances. (R-06/REQ-18)
- `broadcast_ledger_idempotent_per_campaign_recipient` — duplicate `(campaign,customer)` send is a no-op even across processes (ledger), independent of the per-run effect log. (R-07)
- `human_owned_inbound_does_not_run_flow` — while owned, inbound is recorded and `runtime.run` is NOT called (no side effects); `escalate→'human'` does not throw a missing-agent error. (R-08/REQ-21)
- `renderer_rejects_over_limit` — >3 buttons / >10 rows / over-length labels raise an explicit error (no silent slice). (R-11)

Added (rev3 — omnichannel):
- `same_bot_across_channels` — one agent/flow set, driven by inbound from `whatsapp`, `web`, and `instagram` policies, produces the correct per-channel rendering with NO bot-code change. (REQ-22)
- `web_null_policy_always_open` — `webPolicy` (`hasWindow:false`) never blocks a free-form send and never gates on consent. (REQ-22)
- `instagram_closed_window_tags_or_defers` — Instagram outside the 24h window applies the `HUMAN_AGENT` tag where valid, else `deferred` — never a free-form leak; no WhatsApp-style template attempted. (REQ-22)
- `whatsapp_policy_unchanged_behavior` — the WhatsApp policy reproduces every Phase A–E behavior (window/template/interactive/handoff) — i.e. the generalization didn't regress the WhatsApp path.

### 9.2 Regression (Pass-to-Pass)
- `bun run test` across `kuralle-messaging`, `kuralle-messaging-meta`, `kuralle-core`.
- `bun run typecheck:all` (the full gate, incl. the additive `HarnessStreamPart` variant — prove exhaustive switches still compile).
- The existing multi-platform example still builds and the Messenger/web paths are unaffected.

### 9.3 Validation commands
```bash
bun run build
bun run typecheck:all
bun test packages/kuralle-messaging packages/kuralle-messaging-meta packages/kuralle-whatsapp-engagement
# live smoke (optional, requires WA sandbox creds): run the multi-platform example,
# send an inbound, confirm buttons render + selection routes; force a closed window and
# confirm no free-form leak (sandbox returns an error if it would).
npx tsx packages/kuralle-messaging-meta/examples/multi-platform/server.ts
```
