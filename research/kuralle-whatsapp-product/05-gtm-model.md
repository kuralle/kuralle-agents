# 05 — GTM model: should Kuralle go B2B2C / white-label (à la ChatDash)?

## The ChatDash reference, decoded
ChatDash = a **white-label agency-enablement layer** ("Deliver Voice AI agents under your brand") for agencies/BPOs/MSPs: branded client portals, tiered access + upsell, Stripe billing, a workflow builder — **on top of commodity engines it does not own** (Retell, Vapi, ElevenLabs). It owns *distribution + management + billing*; it rents the *engine*.

**Kuralle is the inverse:** we own a differentiated **engine** (durable exactly-once FSM + window-safety-by-construction + channel-agnostic policies + code-first flows — the [moat](./04-moat.md)) and **lack** the enablement layer (multi-tenant, white-label, billing, portal). So "be like ChatDash" must mean *adopt the distribution model*, **not** the product posture (a thin skin) — copying the skin throws away our only moat.

## The structural fit (why B2B2C is attractive for us specifically)
The competitor research surfaced a complementary gap: **agencies/BSPs have distribution but a shallow/bolt-on engine; Kuralle has a strong engine but no distribution.** 360dialog already proves an agency/ISV channel exists for WhatsApp ("the pipe" for resellers); the AI-agent layer those resellers bolt on is weak everywhere. So a "powered-by-Kuralle" / white-label model **borrows the partner's distribution to monetize our engine** — and it's the exact "powered-by-Kuralle to BSPs" moat-on-top flagged in `04`. The engine's value (reliability, can't-leak, exactly-once, audit) is *highest* for buyers who build on top and resell at scale — i.e., the B2B2C channel is where the moat compounds, not the SMB self-serve channel.

## The three GTM archetypes (and the call)
| GTM | What it is | Leverages the moat? | UI/build cost | Verdict |
|---|---|---|---|---|
| **A. Direct B2B SaaS** | Kuralle sells hosted product to end businesses (vs Wati/Respond.io/Infobip) | Weakly — buyers shop on features/price, not durability | **Highest** (full builder + inbox + onboarding + billing) | **Not primary** — crowded, CAC-heavy, late, least moat-leverage |
| **B. Developer / code-first (PLG)** | Sell SDK/API/cloud to devs & platform teams building transactional bots | **Strongly** — exactly our ICP | **Lowest** (SDK + docs + CLI exist) | **Start here** — cheap, differentiating, seeds credibility + design partners |
| **C. B2B2C / white-label / powered-by** | Agencies, BSPs, vertical-SaaS embed Kuralle, serve businesses (→ consumers) under their brand | **Strongly** — engine value compounds per partner; borrows their distribution | **High but different** (multi-tenant + sub-accounts + white-label + usage billing + a deliverable builder/inbox) | **Primary scale GTM — but as "engine + platform," not a ChatDash skin** |

## Recommendation
**Yes — make B2B2C/white-label the primary *scale* GTM, but earn it via the developer wedge first, and own the engine (don't be a management skin).**
- **Sequence:** B (developer/API/embed) → land 2–3 design-partner agencies/BSPs/vertical-SaaS → then build C (multi-tenant, sub-accounts, white-label branding, per-tenant usage metering + billing, a partner/client portal). Don't build the full white-label platform on day one for hypothetical partners; let real partner pull define it.
- **Position to partners:** *"the reliable engine you can't build yourself — durable, exactly-once, provably can't leak outside the 24h window — under your brand."* That is the one thing ChatDash-style players and BSPs **cannot** cheaply replicate, because it's architectural.
- **Keep a thin direct "Kuralle Cloud"** for developers + a few lighthouse brands — to seed credibility, capture reference logos, and own *some* end-to-end data for the eventual analytics/benchmark network effect. Hybrid, but B2B2C is the volume engine.

## What B2B2C changes about the build scope ([`03`](./03-feature-scope.md))
It **reshapes, not removes**, the UI work — and front-loads multi-tenancy:
- **Now load-bearing day one:** org hierarchy / sub-accounts, white-label theming, per-tenant usage metering + margin/markup controls, partner + client portals, RBAC. (These were "control plane — L" in `03`; B2B2C makes them mandatory and earlier.)
- **The XL anchors don't disappear:** agencies still need a builder + a team inbox to actually deliver for clients — arguably *more* demanding (multi-tenant, brandable). But the agency owns the last-mile *relationship and marketing surface*, so we can ship a more operator-focused (less polished-self-serve) builder/inbox sooner.
- **Meta is harder, not easier:** as a Tech Provider enabling many sub-businesses, Embedded Signup + per-WABA provisioning + Meta compliance/limits become central and long-lead. Start immediately.

## Honest risks (why this isn't a free lunch)
- **Distribution dependence + margin compression.** Agencies own the end-customer + data; they will squeeze the wholesale price exactly as everyone squeezes Meta's per-message fee. We become a supplier — weaker direct data/network-effect moat.
- **It is *not* a shortcut around the platform build.** Multi-tenant white-label + billing is a serious lift; ChatDash's apparent simplicity is because it offloads the engine. We carry both engine *and* platform.
- **Channel-quality risk:** low-quality agency resellers can get WABAs flagged/banned by Meta, which can splash back on our Tech-Provider standing. Needs partner vetting + guardrails (our window-safety/consent gates actually help here — a selling point).
- **The voice-agency gold-rush (ChatDash's exact market) is frothy.** WhatsApp-text-for-agencies is steadier but less hyped; don't assume the voice-reseller frenzy maps 1:1.

## Verdict + flip conditions
- **Pick: developer-wedge → B2B2C/white-label as the scale GTM, owning the engine; thin direct cloud alongside.** Rationale: it's where our engine moat compounds, it solves the distribution gap by borrowing partners' reach, and it's defensible because the engine is architectural (hard for a ChatDash-style skin to replicate).
- **Flip to direct-B2B-first if** a partner channel fails to materialize in ~2–3 quarters of design-partner outreach (agencies prefer building on commodity engines they can swap).
- **Flip to pure engine-licensing / "Stripe-for-WhatsApp-agents" infra if** partners want *only* the runtime and reject our UI — then double down on API + durable infra and let partners own all UI.
- **Don't** become a ChatDash-style thin management skin over someone else's engine — that discards the one moat we have.
