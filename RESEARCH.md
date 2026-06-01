# Research — WhatsApp AI engagement on Kuralle

> Phase 2 artifact (feature-plan). Durable, cached research so later sessions don't re-explore.
> Every external claim is sourced; every codebase claim is `file:line` against this monorepo.
> Companion: [`CONCEPT.md`](./CONCEPT.md).

---

## 1. WhatsApp Cloud API — the binding constraints (Meta developer docs)

These are the rules any WhatsApp agent must obey; they drive most of the design.

- **24-hour customer service window.** A user message (or call) opens a 24h window; another inbound resets it. **Inside** the window the business may send free-form "service messages" (no pre-approval). **Outside** it, **only pre-approved template messages** can be sent — a free-form send is rejected. A user reply to a template opens a fresh window.
- **Opt-in is a prerequisite.** Only message users who have opted in; opt-in may be collected on any channel and must name the business and state the user is opting in. `STOP`-style opt-out must be honoured.
- **Template messages.** Exactly three categories: `authentication`, `marketing`, `utility` (category set at creation, affects pricing). Templates are reviewed (up to ~24h) and must be `APPROVED` to send; post-approval quality states (`Paused`/`Disabled`) make a template unsendable. Parameters are `named` (`{{first_name}}`) or `positional` (`{{1}}`); each needs an example at creation. Buttons: `quick_reply`, `url`, `phone_number`, `copy_code`, `otp`, `flow`, `catalog`, `mpm` (≤10 total, ≤25-char labels). Carousel (≤10 cards) and limited-time-offer are marketing variants.
- **Interactive messages (session-only, free-form).** Reply buttons (**≤3**), list messages (**≤10 rows total**; row title ≤24, desc ≤72, list button ≤20), CTA-URL button, media carousel (2–10 cards). WhatsApp **Flows** = an interactive form sent via a flow button (also usable in templates).
- **Inbound message types** (`messages[].type`): `text`, media (`image`/`audio`/`video`/`document`/`sticker`), `location`, `contacts`, `reaction`, **`button`** (template quick-reply tap; payload in `messages[].button.payload`), and **`interactive`** where `interactive.type` ∈ `button_reply` (id+title), `list_reply` (id+title+desc), **`nfm_reply`** (Flow submission; data in `interactive.nfm_reply.response_json`). **Note:** template quick-reply taps arrive as top-level `button` (with `.payload`), whereas free-form reply-button taps arrive as `interactive`/`button_reply` — an agent must handle both shapes.
- **Status webhooks** (`statuses[].status`): `sent`, `delivered`, `read`, `failed`, `played`; carry conversation + pricing info (incl. window `expiration_timestamp`).

**Agent implications:** track the window per-user from the last inbound; gate outbound to APPROVED templates when closed; persist opt-in; pre-approve any re-engagement template; route inbound by type (`text`→NLU; `button`/`button_reply`/`list_reply`→id→intent; `nfm_reply`→parse form JSON); respect interactive size limits.

Sources: developers.facebook.com WhatsApp docs — send-messages (service messages / 24h window), templates/overview, templates/components, interactive-list, interactive-reply-buttons, interactive-media-carousel, marketing/limited-time-offer, flows/guides/flowswebhooks.

## 2. Engagement-platform model (WATI) + BSP state-machine patterns

Reference points for the **proactive-outbound** scope and the conversation model. Treated as *prior art*, not requirements.

- **WATI** (wati.io): shared **team inbox**; **broadcast campaigns** + **drip/sequence** automations (per-step delays, **stop-on-reply**, 7-day retry); a no-code **chatbot/flow builder** (nodes + conditional edges); **keyword triggers** (exact/fuzzy/contains, priority exact>contains>fuzzy); **conditions** (equal/contains/starts-with/numeric, AND/OR); **fallback / business-hours / human-handoff** via rules — including a "customer inactivity" rule that fires at the **23rd hour** to keep the window alive; **CRM** with custom attributes + static/dynamic segments; template-vs-session messaging with explicit 24h-window handling; REST API + lifecycle webhooks (`templateMessageSent_v2`, `sentMessageDELIVERED/READ/REPLIED_v2`, `messageReceived`, `templateMessageFailed`). Source: wati.io + support.wati.io (platform overview, chatbot nodes, keyword actions, conditions, default action, template-vs-session, opt-in guides).
- **BSP state-machine patterns** (to mirror, not copy):
  - **Twilio Studio** — explicit visual state machine: Widgets (nodes) + named transitions (edges). `Send & Wait For Reply` is the canonical collect/gather node (sends, then **halts** awaiting inbound; transitions Reply/No-Reply/Delivery-Fails) — durable wait is an engine feature. `Split Based On` = decision/router on a variable (named edges + default). `Send to Flex` = human handoff. Source: twilio.com/docs/studio.
  - **Twilio Conversations** — long-lived session container with lifecycle `Initializing→Active→Inactive→Closed` driven by Inactive/Closed timers, plus a JSON `Attributes` blob for state. Source: twilio.com/docs/conversations.
  - **respond.io / Gupshup** — automation = Trigger + Steps (Send / **Ask a Question**→save→**Branch** / Assign / Jump / Wait / **Trigger Another Workflow**). **Human handoff = an ownership/assignment flag** that suppresses bot replies (assignment can itself be a trigger). Source: respond.io/help/workflows; Gupshup flow-bot docs.

**Cross-platform synthesis (the shape to adopt):** a nodes-and-named-edges graph where each node SENDS / COLLECTS (send+wait, reply/timeout edges) / DECIDES (branch on a variable) / ACTS; a durable session with state + lifecycle; pause-on-input as a first-class engine feature; **re-engagement past the 24h window = a distinct "send-template" edge** that reopens the window; selection routing by inspecting the inbound payload; **human handoff = an ownership flag** (optionally routed by team/skill).

## 3. Kuralle codebase grounding (what exists, what's missing, the exact seams)

### 3.1 Flow engine (already provides the state machine)
- Node primitives + `Transition` union (`goto`/`handoff`/`escalate`/`end`/`stay`): `packages/kuralle-core/src/types/flow.ts`.
- Durable pause/resume: a node returns `'stay'` → `awaitingUser`, run persisted, next `run()` re-enters at `activeNode`: `packages/kuralle-core/src/flow/runFlow.ts:132,166`; `decide` is a structured model call routed by edge: `runFlow.ts:90`.
- Durable run/replay + **exactly-once** effect log (tool/now/uuid/signal): `packages/kuralle-core/src/runtime/ctx.ts:94` (`replayOrExecute`), `runtime/durable/`.
- Orchestration precedence (resume active flow, else triage selector, else free conversation): `runtime/hostLoop.ts`.

### 3.2 WhatsApp transport (already built)
- `WhatsAppClient` / `createWhatsAppClient` — full Cloud API: `sendText` (auto-split 4096), `sendMedia`, `sendInteractive` (button/list/cta/flow), **`sendTemplate`**, **`sendTextOrTemplate`** (window-aware fallback), `sendReaction`/`sendLocation`/`sendContacts`, `markAsRead`, `uploadMedia`/`downloadMedia`, `templates.*` + `flows.*` CRUD: `packages/kuralle-messaging-meta/src/whatsapp/client.ts`.
- Inbound normalisation `toInboundMessage` sets `text = msg.text?.body ?? extractTextFallback(msg)`; `extractTextFallback` returns the **button/list title** (not id); the structured `interactive.id` is set on `InboundMessage.interactive.id`: `whatsapp/client.ts:592,701`. `nfm_reply` is **not** extracted.
- Webhook verify/normalise/dedup: `messaging-meta/src/webhook/` (`verifier.ts`, `normalizer.ts` — does surface `button_reply`/`list_reply`/`button`).

### 3.3 Runtime bridge (already built)
- `createMessagingRouter({ runtime, platforms, sessionResolver?, responseMapper?, onStatus?, onError?, fallbackMessage? })`: `packages/kuralle-messaging/src/adapter/createMessagingRouter.ts`. On inbound: dedup → `windowTracker.recordInbound` → `sessionResolver.resolve` → `input = message.text ?? '[${type}]'` (**line 66**) → `runtime.run({input, sessionId, userId})` → `StreamMapper.mapStream`.
- Session key = `{platform}:{threadId}`: `adapter/session-resolver.ts:14` (and WA `threadId = whatsapp:{phoneNumberId}:{from}`).
- `WindowTracker`: `recordInbound`/`recordExpiry`/`isWindowOpen`/`getExpiry`, 24h default: `adapter/window-tracker.ts`.
- `StreamMapper.defaultMapResponse` sends **text only** (buffers `text-delta`, ignores other parts): `adapter/stream-mapper.ts:105`.

### 3.4 The extension seams the build will use (grounded)
- `MessagingRouterConfig` already accepts `sessionResolver?` and `responseMapper?`: `types/adapter.ts:47`.
- `ResponseMapper.mapResponse(parts, ResponseContext)` where `ResponseContext = { threadId, platform, sendText, sendInteractive, sendMedia }`: `types/adapter.ts:21,32`.
- `SessionResolver.resolve(message) → { sessionId, userId? }`: `types/adapter.ts:16`.
- `PlatformClient` (platform-agnostic): `sendText/sendMedia/sendInteractive/sendRaw`, handlers, media, `formatConverter`, `webhookRouter`, optional `healthCheck`: `types/client.ts:43`.

### 3.5 Verified gaps → and what each implies for the design
1. **Window tracked, not enforced.** Router records the window but the default mapper sends free-form unconditionally (`stream-mapper.ts:111`). *Fix:* enforce in core (default-safe).
2. **`ResponseContext` lacks `sendTemplate` + window state; `PlatformClient` lacks `sendTemplate`.** `sendTemplate`/`sendTextOrTemplate` exist only on the concrete `WhatsAppClient`. *Implies:* extend `ResponseContext` (add `windowOpen`/`sendTemplate`) and add `sendTemplate?` to `PlatformClient` (capability-detected), or inject the `WindowTracker` + client into the mapper.
3. **Input is text-only; `id` and `nfm_reply` are lost.** Router derives `input = message.text ?? '[type]'`; `SessionResolver` returns only `{sessionId,userId}` and does **not** control `input`. *Implies:* a new input-resolution seam in core (e.g. `inputResolver(message) → string`, or extend `SessionResolver` to also return `input`) so flows can route on stable ids; and extract `nfm_reply.response_json` in the WA client/normaliser.
4. **No render of `collect`/`decide` options.** `StreamMapper` ignores non-text parts. *Implies:* a richer stream contract (node emits its interactive options as a stream part) + a `responseMapper` that renders buttons/list/Flow via `sendInteractive`.
5. **No handoff ownership gate.** *Implies:* an ownership flag in session state + a `responseMapper`/hook short-circuit while owned.

## 4. Open design questions (to resolve in the RFC, Section 12)

- **Q1.** Where does window enforcement live — extend `ResponseContext`/`PlatformClient` with `sendTemplate` + `windowOpen`, or inject `WindowTracker`+client into a core mapper? *(Leaning: extend the contract; capability-detect `sendTemplate`.)*
- **Q2.** Input-resolution seam — new `inputResolver` hook vs extending `SessionResolver` to return `input`. *(Leaning: dedicated `inputResolver`, keep concerns separate.)*
- **Q3.** How a node declares its interactive options to the renderer — a new `HarnessStreamPart` variant emitted by `collect`/`decide`, vs metadata on existing parts. *(Affects core stream contract.)*
- **Q4.** Smart-send node vs guard division of labour, and where the AI template-selection step runs (a Kuralle `action`/tool vs a messaging-layer step). Guardrails: only `APPROVED` + non-`Paused` templates; validate params; audit every conversion.
- **Q5.** Where ownership/consent/opt-in/window state persists — Kuralle `SessionStore` (per-conversation) vs an external store; matters for multi-process + the future inbox.
- **Q6.** Scheduler for broadcasts/drips — external (cron/queue driving `runtime.run`) vs in-package; how stop-on-reply is enforced.

## 5. Scope guardrails (no overshoot)

**In:** window enforcement (core fix) · smart-send strategist (guard + node, AI-from-catalog) · full interactive (buttons/list/cta/Flows + id-routing + `nfm_reply`) · handoff ownership gate · opt-in/consent · broadcasts + drips + re-engagement · new `@kuralle-agents/whatsapp-engagement` package · proven on `multi-platform` example.

**Out (separate downstream plan):** CRM/contacts/segments UI · team-inbox UI · analytics dashboards · no-code visual builder. The engine is *designed to support* these, but they are not built here.

## 6. Channel matrix (rev3 — omnichannel)

The engagement engine is channel-agnostic; each channel is one injected `ChannelPolicy`. Only the bottom rows differ per channel.

| Capability | WhatsApp | Web / SSE | Instagram | Messenger (deferred) |
|---|---|---|---|---|
| Messaging window | 24h customer-service window | none (always open) | 24h window | 24h window |
| Closed-window recovery | approved **template** (AI strategist) | n/a | **human-agent tag** (~7d) for handoff; otherwise none → defer | message tags / one-time / recurring notifications |
| Proactive (broadcast/drip) | yes (templates) | n/a (synchronous) | **limited** — no template-approval system; mainly reactive + handoff window | yes (tags/notifications) |
| Consent required | yes (opt-in + STOP) | no | yes | yes |
| Interactive out | reply buttons(≤3) / list(≤10) / cta / Flows | web UI elements | quick replies / generic-template carousels (no list/Flows) | quick replies / button+generic templates |
| Inbound selection | button_reply / list_reply / template button / nfm_reply | UI-supplied selection | quick-reply / postback payload | quick-reply / postback |
| Maps to `ClosedWindowStrategy` | `template` | `none` | `message-tag` | `message-tag` |

Sources: WhatsApp rows are Meta-doc-grounded (§1). **Web** follows from the framework (SSE transport, no window). **Instagram / Messenger** rows are from general Messenger-Platform knowledge and the package's existing clients (`messaging-meta/src/{instagram,messenger}`) — **these MUST be re-verified against current Meta Instagram/Messenger Platform docs at build time** (window mechanics, human-agent tag duration, message-tag categories, interactive caps). This session's external research was WhatsApp-centric; the IG/Messenger specifics here are design inputs, not yet primary-source-verified.
