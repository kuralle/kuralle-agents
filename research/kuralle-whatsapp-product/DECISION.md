# DECISION — "Build your next WhatsApp Bot with Kuralle"

> **GTM decision (committed 2026-06): DEVELOPER-FIRST.** Sell the engine + SDK + dev loop to developers/platform teams building transactional bots. B2B2C/white-label ([`05`](./05-gtm-model.md)) is the later scale layer, unlocked by developer-channel pull — not built now. Direct-B2B-SaaS (visual builder, team inbox) is deprioritized. Plan: [`06-developer-first-plan.md`](./06-developer-first-plan.md).

## TL;DR
> The WhatsApp-bot market is **commoditized at the marketing/BSP layer** (everyone resells Meta + charges a per-message markup over a no-code builder + shared inbox) and **immature at the durable-agent layer** (AI is a bolt-on; the 24h-window/template logic is a billing footnote, not a constraint the agent reasons about). Kuralle's defensible wedge is **the engine, not another builder**: it sits in an **empty 2026 intersection** — *durable exactly-once run-state + native WhatsApp depth + code-first structured flows + closed-window-safety-by-construction* — that no competitor occupies (durability infra has no channel; WhatsApp-deep products publish no durability; closed-window safety is the developer's burden everywhere). **Position as the reliable, durable agent runtime for transactional WhatsApp**, lead with compliance/reliability, and treat the no-code UI as table-stakes to add later — not the differentiator. **It's a head-start, not a fortress**; the durable business moat must be built on top (developer ecosystem + compliance verticals + eventual data/analytics).

## What we already have vs. what the full product needs
- **Engine: ~done** (durability, window-safety, channel-agnostic policies, strategist, interactive, consent, broadcasts — [`02`](./02-capability-inventory.md), validated by the booking/pharmacy/clothing example apps).
- **Net-new is ~80% the SaaS/UI shell** ([`03`](./03-feature-scope.md)): two **XL** anchors — visual flow builder and live team inbox; **L** items — Meta Embedded Signup onboarding, template-approval workflow UI, contacts/CRM, analytics, multi-tenant control plane + billing; plus a flow-IR (canvas⇄code) and durable store adapters. This is the inverse of the incumbents (rich UI over a shallow engine).

## Positioning (the one sentence)
**"Build your next WhatsApp bot with Kuralle — the durable agent runtime where a closed-window message can't leak, every tool call runs exactly once, and one bot runs across WhatsApp, web, and Instagram."** Aimed at **developers / platform teams** building *transactional* bots (commerce, pharmacy, bookings, finance) — not the SMB-marketer broadcast crowd the incumbents farm.

## What to build first (sequence — ship value before the XL anchors)
1. **Lean into the code-first strength now** (S–M): polish SDK + the 3 example apps + docs/cookbook + a `kuralle dev` CLI wrapping the headless simulator. This is shippable *today* and differentiates immediately.
2. **Durable store adapters** (S–M, BK-06) — required before any multi-tenant/hosted offering.
3. **Meta Embedded Signup onboarding** (L) — the long-lead external dependency (Meta Tech-Provider review); start early; it gates self-serve.
4. **Strategist config + audit UI + per-channel render preview** (M each) — cheap surfaces that *show the moat* (compliance/reliability).
5. **Broadcast/campaign composer** over the existing engine (M).
6. **Then** the XL anchors — visual builder (needs the flow-IR first) and team inbox — sequenced, not parallel; a strong API lets us sell before either is complete.

## Moat (summary — full grading in [`04`](./04-moat.md))
- **Lead moats:** window-safety-by-construction (Medium-High) + durable exactly-once FSM (Medium-High) → their **combination is THE moat** (the empty triple intersection).
- **Supporting:** smart-send strategist + audit (compliance angle).
- **Not standalone moats (honest):** channel-agnosticism (matched by Infobip/Sprinklr) and code-first structured flows (matched by LangGraph/Rasa/Cognigy).
- **Business moat to build on top:** developer ecosystem/switching costs · compliance wedge into regulated verticals · multi-tenant data/analytics network effects · "powered-by-Kuralle" distribution to BSPs.

## Flip conditions
- **Re-position if** Cognigy/Infobip ship documented durable-execution + exactly-once + structural window-safety → the tech head-start erodes; double down on ecosystem + compliance.
- **Accelerate the ecosystem/data moats if** LangGraph or Temporal ship a first-class native WhatsApp channel → the triple intersection gets occupied.
- **Switch to a powered-by-BSP distribution play if** the developer ICP proves too narrow to monetize direct-SaaS.
- **Don't** try to out-feature ManyChat/Wati on marketing-blast + no-code canvas — that's the commoditized race to the bottom; we'd be late and undifferentiated.

## Confidence / gaps
Competitor *feature/positioning* facts are well-cited; enterprise *pricing* is third-party/directional (sales-gated); SaaS-CX *durability/exactly-once* claims are **absence-of-evidence** (no vendor publishes a guarantee) — flagged, not asserted. The moat thesis rests on that absence holding; the flip conditions cover it being wrong.
