# 01a — WhatsApp-native bot/marketing builders (2026)

Shared substrate: all resell the **Meta WhatsApp Business Platform**, so 24h-window + template categories + per-message billing are common. As of **Jan 1 2026** Meta is fully **per-message** (Marketing/Utility/Auth/Service); service replies inside the open window are free; out-of-window business-initiated sends require a **pre-approved template** [1][2]. Differentiation = the workflow wrapper (template UX, window enforcement, Flows, AI) + the markup on Meta rates.

| Product | Positioning | Pricing | WhatsApp depth | AI depth | Key gap |
|---|---|---|---|---|---|
| **Wati** | SMB→mid; support+mktg | ~$59–349/mo + **~20% Meta markup** [3] | Templates, builder, broadcasts, inbox, **Flows** [4] | "KnowBot"/Copilot = **credit-metered RAG-lite** [3] | hidden markup; shallow AI |
| **Interakt** | India D2C/Shopify | ₹3.5–10.5k/qtr + **~25% markup** [5] | Templates, **Flows** + "flow completed" retarget [6], catalog | **No native AI** — rents **Haptik** add-on [5] | AI is paid 3rd-party |
| **AiSensy** | India mktg-first | free + ₹1.5–3.2k/mo + per-msg [7] | Broadcasts, templates, builder, Flows [8] | no-code + KB "AI Agent" = RAG-lite [8] | **weak analytics** [7] |
| **DoubleTick** | SMB sales; commerce | ~$142/mo+ [9] | Multi-number inbox, catalog, commerce flows [9] | **commerce AI**: image→add-to-cart, sentiment [9] | AI breadth undocumented |
| **Gupshup** | mid→enterprise omnichannel | **opaque/negotiated** [11] | Deepest: full lifecycle, Flows, catalog | **native "ACE LLM" + tool-calling agents** [10] | opaque pricing; SMB overkill |
| **360dialog** | devs/ISVs (infra BSP) | ~€49/mo + **flat $0.005/msg, NO markup** [12] | Near-raw Cloud API; you build the UX | **none** (pure pipe) [12] | no builder/inbox/AI |
| **Trengo** | EU mid; omnichannel inbox | €299–499/mo, usage [14] | WA = one of 10+ channels; breadth not depth | "AI HelpMate" **siloed from flows** [14] | AI≠automation; shallow WA |
| **BotSpace** | SMB Shopify | from **$15/mo, no markup** [15] | Broadcasts, cart recovery, builder [15] | "AI-first": segmentation, **AI voice agents** [15] | feature gaps; young |
| **WebEngage/Netcore** | enterprise CEP (WA = a channel) | MAU-tier ₹3–6L/yr / $50–120k [16][17] | WA inside cross-channel journeys | Netcore **agentic** (campaign agents) [17] | WA not core; conversational AI weaker than campaign AI |

## Synthesis
**Commoditized (table stakes):** reselling Cloud API; template management + Meta-approval submission; broadcasts; no-code decision-tree builder + human handover; shared inbox; interactive buttons/lists; Shopify hooks. **WhatsApp Flows** has crossed from differentiator to expected. Charging a **markup on Meta per-message fees** is near-universal (Wati ~20%, Interakt ~25%); *absence* of markup (360dialog, BotSpace) is now the marketed feature.

**Rare:** (1) zero-markup developer-grade API access as a posture (only 360dialog, BotSpace); (2) a genuinely **native first-party LLM agent** vs an FAQ/KB bot or 3rd-party bolt-on (only Gupshup, arguably Netcore — Interakt literally rents AI from Haptik); (3) applied commerce-specific AI (DoubleTick image→cart, BotSpace COD voice agents).

**AI is weak across the board:** most "AI agents" are **RAG over an FAQ KB + a handover rule**. Tells: AI is credit-metered (Wati), a paid 3rd-party (Interakt/Haptik), or **siloed from the flow engine** (Trengo: "AI or automation, not both"). True multi-step tool-calling agents that read order state / mutate carts / transact **inside the 24h window**, grounded + reliable, are claimed by few and independently verified by ~none. Resolution benchmarks are self-reported.

**Biggest exploitable gap (the agent's verdict, and it's ours):** a **native grounded conversational agent that is first-class with the flow engine AND the WhatsApp protocol simultaneously** — one runtime where LLM agent + structured flow share state, the agent does real tool-calling with exactly-once guarantees, and the system is **window-aware** (knows it's outside 24h → gates/queues to an approved template instead of failing or dropping). Today AI is a sidecar next to the builder; window/template logic is a billing footnote, not a first-class constraint the agent reasons about. **Owning the seam grounded-agent ↔ structured-SOP ↔ window/template mechanics is the open, defensible moat.**

## Sources
[1] developers.facebook.com/.../whatsapp/pricing · [2] m.aisensy.com/blog/whatsapp-per-message-pricing-update-effective-january-1-2026 · [3] chatarmin.com/en/blog/wati-pricing · [4] support.wati.io/.../whatsapp-flows-in-wati · [5] zoko.io/post/interakt-pricing-guide; respond.io/blog/interakt-review · [6] interakt.shop/.../use-whatsapp-flow · [7] aisensy.com/pricing/usd; quickreply.ai/.../aisensy-pricing-plans · [8] m.aisensy.com/blog/build-whatsapp-ai-agents · [9] doubletick.io; getapp.com/.../doubletick · [10] gupshup.ai/ace-llm; gupshup.ai/conversation-cloud · [11] support.gupshup.io/.../360012075779; capterra.com/p/233786/Gupshup · [12] 360dialog.com/pricing · [13] whapi.cloud/blog/whatsapp-bsp-pricing-hidden-costs-2026 · [14] chatarmin.com/en/blog/trengo-pricing · [15] bot.space/pricing; g2.com/products/botspace/reviews · [16] blog.campaignhq.co/webengage-moengage-clevertap-pricing-india-2026 · [17] netcorecloud.com/blog/webengage-vs-moengage · [18] respond.io/help/whatsapp/whatsapp-message-templates

**Uncertainty:** Gupshup pricing (third-party estimate, sales-led/opaque); Flows support for DoubleTick/BotSpace plausible but unconfirmed; Trengo "50%+ resolution" self-reported.
