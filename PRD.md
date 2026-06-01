# PRD — WhatsApp AI customer-engagement agents on Kuralle flow primitives

> Status: **Draft** (Phase 4, feature-plan). Product contract — the *what* and *why*.
> Technical contract (interfaces, pseudocode) lives in the later RFC. See [`CONCEPT.md`](./CONCEPT.md), [`RESEARCH.md`](./RESEARCH.md).
> Scope: **conversational engine + proactive outbound**. Local artifact (no GitHub issue this run).

## Problem Statement

A developer building a WhatsApp customer-engagement agent on Kuralle today gets the hardest parts for free — a durable, resumable conversation state machine and a production WhatsApp transport — but cannot ship safely:

- Their agent can **silently fail to deliver**: outside WhatsApp's 24-hour window, free-form messages are rejected by Meta, and Kuralle's default send path sends them anyway (the window is tracked but never enforced).
- Their flows can **only speak in plain text**: there is no first-class way to present WhatsApp buttons, lists, CTA buttons, or Flows, and when a customer taps a button or list row the agent receives only the visible label — the stable selection id is dropped, and WhatsApp Flow form submissions aren't parsed at all. Routing becomes guesswork.
- They have **no safe way to hand off to a human**: nothing stops the bot from talking over a live agent who has taken the conversation.
- They have **no proactive outreach**: no opt-in/consent enforcement, no broadcasts, no drip sequences, and no compliant way to re-engage a customer after the window closes.

The result: every team rebuilds the same fragile glue, and most get the window rules, interactive routing, and consent wrong — which risks failed deliveries and WhatsApp account penalties.

## Solution

A thin, reusable layer that turns Kuralle into a **safe, full-fidelity WhatsApp agent engine with proactive outbound**, so a developer authors normal Kuralle flows and gets WhatsApp-correct behavior by default.

- **Window-safe by default.** Every outbound is gated by the live 24-hour window. Inside the window, free-form replies send normally; outside it, the system never lets a free-form message leak to Meta.
- **Smart send strategist.** When the window is closed (or a flow opts in), a strategist decides whether to send a template or free-form. When it must convert, it **selects an approved template from the catalog using AI** and fills its parameters — behind deterministic guardrails (only APPROVED/non-paused templates, validated parameters, an audit record of every conversion). It works two ways: an **automatic guard** that protects authors who do nothing, and an **explicit flow node** for authors who want control.
- **Full interactive fidelity.** Flow steps that gather a choice render as WhatsApp **buttons / list / CTA / Flows**; customer selections route **deterministically by stable id** (including template quick-reply taps), and WhatsApp **Flow form submissions** are parsed into flow state.
- **Human-handoff ownership.** Handing a conversation to a human sets an ownership flag that **silences the bot** until the human releases it.
- **Proactive outbound.** Opt-in/consent is enforced (including `STOP`/opt-out); developers can run **broadcasts** and **drip/sequence** campaigns (per-step delays, stop-on-reply), and **re-engage after the window** via a template that reopens it and resumes the customer's flow.

Delivered as a new `@kuralle-agents/whatsapp-engagement` package plus a correctness fix in `@kuralle-agents/messaging`, and demonstrated on the existing multi-platform example.

## User Stories

**Window safety**
1. As a developer, I want closed-window free-form replies to never reach Meta, so that my agent doesn't silently drop messages or risk penalties.
2. As a developer, I want the 24-hour window tracked per customer from their last inbound message, so that send decisions are always based on the real window state.
3. As a developer, I want the window to also honor the platform-reported expiry from status webhooks, so that my window state matches Meta's exactly.
4. As a developer, I want window-safe behavior to be the default (not opt-in), so that I can't forget to enable it.
5. As an end customer, I want to never receive a broken/blank experience caused by a rejected message, so that the conversation feels reliable.

**Smart send strategist**
6. As a developer, I want a flow's free-form reply to be automatically converted to a compliant template when the window is closed, so that my flow logic doesn't have to know about windows.
7. As a developer, I want the strategist to pick the best approved template from my catalog by intent, so that I don't hand-map every message.
8. As a developer, I want template selection constrained to APPROVED, non-paused templates only, so that I never attempt to send an unsendable template.
9. As a developer, I want template parameters filled from flow state/context and validated before sending, so that conversions don't produce malformed messages.
10. As a developer, I want every automatic template conversion recorded (what was requested, which template was chosen, params), so that I can audit and debug re-engagement.
11. As a developer, I want an explicit "smart send" flow node, so that I can control the template-vs-freeform decision at a specific step when I need to.
12. As a developer, I want to disable/override the automatic guard on a specific step, so that I retain full control where it matters.
13. As a developer, I want a clear, observable outcome when no suitable template exists for a closed-window send (deferred + event, not a silent failure), so that I can handle the edge case.

**Interactive fidelity**
14. As a developer, I want a flow step that offers choices to render as WhatsApp reply buttons (≤3), so that customers tap instead of typing.
15. As a developer, I want larger choice sets to render as a WhatsApp list message (≤10 rows), so that I can present more options compliantly.
16. As a developer, I want to send CTA-URL buttons and WhatsApp Flows from a flow step, so that I can drive web actions and in-chat forms.
17. As a developer, I want a customer's button/list selection to route my flow by its stable id, so that routing is deterministic and not dependent on display text or language.
18. As a developer, I want template quick-reply taps (which arrive in a different inbound shape) handled the same way as interactive replies, so that I don't special-case them.
19. As a developer, I want WhatsApp Flow submissions parsed into flow state, so that I can use the submitted form data in subsequent steps.
20. As a developer, I want free-text replies to still work alongside buttons (NLU fallback), so that customers who type instead of tapping aren't stuck.
21. As an end customer, I want to pick from clearly labeled buttons/lists, so that I can respond quickly without typing.

**Human handoff**
22. As a support lead, I want handing a conversation to a human to immediately silence the bot, so that the agent and the bot don't talk over each other.
23. As a developer, I want `escalate`/handoff in a flow to set the human-ownership state, so that handoff is expressed in normal flow terms.
24. As a support agent, I want the bot to stay silent until ownership is released, so that I fully control the conversation while I'm on it.
25. As a developer, I want inbound messages during human ownership to be recorded (not auto-answered), so that history stays complete for when the bot resumes.
26. As a developer, I want releasing ownership to resume the customer's flow where it paused, so that automation continues seamlessly.

**Consent & opt-out**
27. As a compliance owner, I want messaging blocked to customers who haven't opted in, so that we follow WhatsApp policy.
28. As an end customer, I want to send `STOP` (or opt out) and immediately stop receiving messages, so that I'm in control.
29. As a developer, I want opt-in/opt-out state persisted per customer, so that it's enforced across sessions and restarts.
30. As a compliance owner, I want opt-out to halt active drips/broadcasts for that customer, so that we never message someone who left.

**Proactive outbound — broadcasts & drips**
31. As a developer, I want to send a template broadcast to a list of opted-in customers, so that I can run outreach campaigns.
32. As a developer, I want a customer who replies to a broadcast to be handed into a flow, so that outreach turns into a real conversation.
33. As a developer, I want broadcast sends to be idempotent (no double-send on retry), so that customers aren't messaged twice.
34. As a developer, I want to define a drip/sequence of steps with per-step delays, so that I can nurture customers over time.
35. As a developer, I want a drip to stop when the customer replies, so that I don't keep pushing once they engage.
36. As a developer, I want to re-engage a customer after the window closes via an approved template that reopens the window and resumes their flow, so that long-running journeys survive the 24-hour limit.
37. As a developer, I want failed proactive sends surfaced (with reason), so that I can react to template/quality/window problems.

**Foundation & proof**
38. As a developer, I want all of this to run on one Kuralle runtime alongside Messenger and web chat, so that I maintain one agent stack across channels.
39. As a developer, I want the same durable, exactly-once, resumable conversation guarantees Kuralle already provides, so that WhatsApp conversations survive restarts and never double-execute side effects.
40. As a developer, I want a working multi-platform example demonstrating window-safety, buttons/list, handoff, and a broadcast-to-flow, so that I have a reference to copy.

## Implementation Decisions

*(Module-level and behavioral; interface signatures and pseudocode are deferred to the RFC.)*

- **Two-surface delivery.** A correctness fix in `@kuralle-agents/messaging` makes window enforcement the default behavior of the runtime↔platform bridge; a new `@kuralle-agents/whatsapp-engagement` package provides the engagement-specific deep modules (strategist, interactive rendering/routing, ownership gate, proactive engine). Rationale: window-safety is a framework correctness concern (benefits all messaging users); the richer engagement behavior is an opt-in layer.
- **Window enforcement at the send boundary.** The bridge consults the live window state before any outbound and routes a free-form send to the strategist when the window is closed. The window is tracked from inbound timestamps and corrected by platform-reported expiry (both mechanisms already exist).
- **Smart-send strategist as a deep module.** A single testable component decides `template | freeform | defer` given window state, the requested message, and the template catalog; AI template-selection is one pluggable step inside it, fronted by deterministic guardrails (approval/quality filter, parameter validation, audit log). Exposed both as the automatic default guard and as an explicit flow node.
- **Interactive contract.** Flow steps express choice options in a structured way that the engine renders to the right WhatsApp interactive type (buttons/list/cta/flow) within platform size limits; inbound selections are resolved to a stable id (covering `interactive.button_reply`, `interactive.list_reply`, template `button`, and Flow `nfm_reply`) before the flow runs, with free-text NLU as fallback. This requires a small core seam so the bridge can derive flow input from structured selections rather than display text alone.
- **Capability extension.** Template sending is surfaced through the platform-agnostic boundary as an optional capability (capability-detected), so window-safe substitution works without coupling the generic bridge to WhatsApp-only concepts.
- **Ownership gate via session state.** Human ownership is a persisted per-conversation flag checked at the send boundary; while owned, the bot's outbound is suppressed and inbound is recorded.
- **Consent store.** Opt-in/opt-out is persisted per customer and enforced before any outbound (reactive or proactive).
- **Proactive engine.** Broadcasts and drips are driven by seeding `runtime.run` per recipient; scheduling/delays and stop-on-reply are coordinated by the engagement layer; idempotency leans on Kuralle's exactly-once effect log. The scheduler boundary is defined so an external queue/cron can drive it.
- **Persistence.** All new per-conversation/per-customer state (window, ownership, consent, campaign membership) is keyed consistently with the existing session model so it survives restarts and works multi-process via a durable `SessionStore`.

## Testing Decisions

- **Test external behavior, not internals.** Drive scenarios through the public boundaries (inbound webhook event in → outbound platform calls out; strategist input → decision out) and assert observable outcomes, mirroring the repo's existing offline fake-client style (e.g. the voice/e2e fake-client suites and the `messaging` adapter tests).
- **Window enforcement (highest priority):** closed-window free-form send is never emitted as free-form; it converts to a template or defers. Window opens/extends on inbound and on platform expiry.
- **Strategist:** chooses freeform inside window; chooses an APPROVED template outside; refuses paused/rejected templates; validates parameters; defers + emits an event when no template fits; writes an audit record per conversion.
- **Interactive routing:** button/list/Flow selections resolve to the correct stable id and drive the expected transition regardless of label text; template quick-reply taps route identically; `nfm_reply` data lands in flow state; free-text fallback still routes.
- **Ownership gate:** bot outbound is suppressed while owned; inbound is recorded; releasing ownership resumes the paused flow.
- **Consent:** un-opted-in customers are never messaged; `STOP` halts further sends and stops active drips.
- **Proactive:** a broadcast send is idempotent under retry; a reply hands into a flow; a drip stops on reply; re-engagement template reopens the window and resumes the flow.
- **Prior art:** `packages/kuralle-messaging` adapter tests, `kuralle-messaging-meta` whatsapp tests, and `kuralle-e2e-tests` fake-client patterns.

## Out of Scope

Designed-for but **not built** in this plan (separate downstream feature-plan):
- CRM / contacts / attributes / segments management UI.
- Team-inbox UI (the ownership *gate* is in scope; the inbox *product surface* is not).
- Analytics / reporting dashboards.
- No-code visual flow builder.
- Non-Meta channels beyond what the existing transport already covers (engine stays channel-agnostic, but new engagement features target WhatsApp).

## Further Notes

- **Reuse over rebuild.** The durable resumable state machine, exactly-once execution, sessions, transport, webhook verify/normalize, and the 24h `WindowTracker` already exist. This feature is the safety/fidelity/outbound layer on top — not a new engine.
- **Open questions** (to resolve in the RFC, Section 12): exact home of window enforcement (extend the response/platform contract with template-send + window state vs inject the tracker); the input-resolution seam for stable-id routing (new hook vs extend session resolver); how a node declares interactive options to the renderer (new stream-part variant vs metadata); where the AI template-selection step runs and its guardrails; persistence location for ownership/consent/window; and the scheduler boundary for broadcasts/drips. (Details and leanings in `RESEARCH.md` §4.)
- **Compliance is a first-class success criterion**, not a nice-to-have: closed-window leaks and un-consented sends are defects, not edge cases.
