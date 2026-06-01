# Concept — WhatsApp AI customer-engagement agents on Kuralle flow primitives

> Status: **Approved** (Phase 1, feature-plan). Scope: **conversational engine + proactive outbound**.
> Companion artifacts: [`RESEARCH.md`](./RESEARCH.md), and (next) `PRD.md` → `rfcs/whatsapp-engagement/`.

## Problem

Kuralle already owns the hard parts of a WhatsApp agent:

- A **durable, resumable conversation state machine** — `flows` (`reply`/`collect`/`action`/`decide`), the `Transition` union, the durable run/replay store (exactly-once effect log, pause/resume via `'stay'`→`awaitingUser`), `SessionStore`, and `hostLoop` (resume active flow, else triage).
- A **production WhatsApp transport** — `@kuralle-agents/messaging-meta/whatsapp` (full Cloud API client) + `@kuralle-agents/messaging` `createMessagingRouter({ runtime, platforms })`, which bridges an inbound webhook → `runtime.run({ input, sessionId })` → `StreamMapper` → outbound send.

Three **verified gaps** stop it from safely powering real WhatsApp engagement, plus proactive outreach is absent:

1. **24h window is tracked but not enforced.** `WindowTracker` records the window, but the default send path (`StreamMapper.defaultMapResponse`) calls `platform.sendText()` unconditionally — a closed-window free-form send silently fails at Meta.
2. **Outbound is text-only; inbound selection is lossy.** The default mapper sends only buffered text; it never renders `collect`/`decide` options as buttons/list/Flows. Inbound button/list taps reach the flow as the **label text** only — the stable `interactive.id` is on the message but dropped by the router, and WhatsApp Flow `nfm_reply` submissions aren't parsed.
3. **No human-handoff ownership gate.** Nothing suppresses the bot while a human owns a conversation.
4. **No proactive outbound.** No opt-in/consent management, broadcasts, drip/sequence campaigns, or re-engagement-after-window.

## End state we will deliver (this plan)

1. **Window-safe messaging, correct by default** — enforcement fixed in `@kuralle-agents/messaging` (the tracked-not-enforced behaviour is treated as a defect).
2. **Smart send strategist** — a **default automatic window guard** on every outbound *and* an explicit **first-class flow node** for fine control. On a closed window (or when a node opts in) it decides template-vs-freeform; when converting, an **AI step selects the best approved template from the catalog and fills parameters**, behind deterministic guardrails (approval-status check, parameter validation, audit log).
3. **Full interactive fidelity** — render `collect`/`decide` options as WhatsApp **buttons / list / CTA / Flows**; route inbound by stable **`interactive.id`** (and template `button`/`list_reply`); parse **WhatsApp Flow `nfm_reply`** submissions into flow state.
4. **Human-handoff ownership** — `escalate`/handoff sets an ownership flag that suppresses the bot while a human owns the chat and resumes on release.
5. **Proactive outbound** — opt-in/consent + `STOP` handling; **broadcasts** and **drip/sequence** campaigns (delays, stop-on-reply); **re-engagement-after-window** via a template that reopens the window and resumes the flow.

## Shape (rev3 — omnichannel)

- The engagement layer is **channel-agnostic**: package **`@kuralle-agents/engagement`** (pipeline, ownership gate, consent, interactive declaration, broadcast/drip, selection seam) + window enforcement fixed in core (`@kuralle-agents/messaging`). The **same bot** (Kuralle flows/agents) deploys across every channel unchanged.
- Channel differences live behind an injected **`ChannelPolicy`** (window model + `ClosedWindowStrategy` + per-channel interactive rendering + consent). Concrete policies this cut: **WhatsApp** (24h + approved-template strategy + Flows), **Web/SSE** (null policy — always open, no consent), **Instagram** (24h + human-agent-tag handoff; quick-replies/carousels; no template-approval → limited proactive). **Messenger:** designed-for, not built.
- Proven against the **`multi-platform` example** (WhatsApp + Messenger + web on one runtime).
- Architecture spine: inbound webhook → `messaging` router → `runtime.run({ sessionId })` → **flow** → **smart-send strategist** (window guard + AI template selection) → `whatsapp` client. Durable resume + exactly-once come from Kuralle's run/replay; proactive sends are `runtime.run` seeded by a scheduler.

## Explicitly OUT of this plan (designed-for, separate downstream plan)

CRM / contacts / segments UI, team-inbox UI, analytics dashboards, no-code visual builder.

## Key decisions (Phase 1 grill)

| Decision | Choice |
|---|---|
| Packaging | New `@kuralle-agents/whatsapp-engagement` package **+** fix enforcement in core |
| Scope boundary | Engine **+ proactive outbound** (opt-in, broadcasts, drips, re-engagement) |
| Smart-send model | **Both** a default automatic window guard **and** an explicit first-class node |
| Template selection on conversion | **AI chooses from the approved-template catalog** (with deterministic guardrails) |
| Proving ground | `multi-platform` example |
