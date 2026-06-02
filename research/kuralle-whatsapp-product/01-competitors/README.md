# 01 — Competitor landscape: synthesis & verdict

Three segments researched (cited): [WhatsApp-native](./whatsapp-native.md) · [omnichannel/visual-builder](./omnichannel-builders.md) · [AI-agent + dev/durable frameworks](./ai-agent-and-frameworks.md).

## The market map (where everyone sits)
| Tier | Who | Strength | The shared weakness |
|---|---|---|---|
| **BSP / pipe** | 360dialog | cheapest raw Cloud API, no markup | no builder/inbox/AI — you build everything |
| **SMB WhatsApp marketing** | Wati, Interakt, AiSensy, DoubleTick, BotSpace, AiSensy | template+broadcast+inbox, cheap | AI is bolt-on/credit-metered/3rd-party; per-channel flows; window-safety on user |
| **SMB/mid omnichannel builders** | ManyChat, Chatfuel, Landbot, Tidio, Respond.io | strong visual builders, unified inbox | rebuild-per-channel (SMB); ephemeral runs; no durability |
| **Enterprise CPaaS / CXM** | Infobip, Sprinklr, Gupshup, Twilio, Sendbird | deep WhatsApp (Flows, lifecycle), channel-agnostic (Infobip/Sprinklr), native agents | opaque enterprise pricing; **no published durability/exactly-once**; closed |
| **Enterprise CX AI agents** | Sierra, Decagon, Cognigy, Ada, Intercom Fin, Agentforce, Parloa | outcome-priced agents; Cognigy=native WA+structured flows | closed SaaS; WhatsApp abstracted (except Cognigy); durability undocumented; not code-first |
| **Dev / durable infra** | Temporal, Restate, Inngest, LangGraph, Rasa, Vercel AI SDK | true durability/exactly-once (Temporal/Restate/Inngest), code-first FSM (LangGraph/Rasa) | **zero native WhatsApp** — bring-your-own-channel |

## Commoditized vs. rare
- **Commoditized (table stakes):** reselling Cloud API; template management + Meta-approval submission; broadcasts; no-code decision-tree builder + handover; shared inbox; interactive buttons/lists; Shopify hooks; **WhatsApp Flows** (now expected, supported by Infobip/Twilio/Sprinklr/Wati/Interakt); charging a markup on Meta per-message fees.
- **Rare:** native first-party LLM tool-calling agent (Gupshup, Respond.io, Infobip, Sprinklr, Cognigy — most "AI" is FAQ-RAG + handover); zero-markup dev posture (360dialog, BotSpace); truly channel-agnostic "build once" (Infobip, Sprinklr only); applied commerce AI (DoubleTick, BotSpace).
- **Essentially absent (the white space):** **a durable, exactly-once, code-first conversation runtime with structural closed-window safety + native WhatsApp depth.** Durability infra has no channel; WhatsApp-deep products have no published durability; closed-window safety is the developer's burden *everywhere* (Twilio fails with 63016; ManyChat offers a node you can pick wrong). Cognigy is the closest single product (native WA + structured flows) but is closed and durability-opaque.

## Verdict (feeds the moat doc)
The market is **commoditized at the marketing/BSP layer** (price-competing on per-conversation markup) and **immature at the durable-agent layer**. The defensible white space is not "another builder" — it is the **integrated runtime** (durable FSM + window-safety-by-construction + channel-agnostic policies + code-first structured flows). Two honest caveats carried into [`04-moat.md`](../04-moat.md): (1) **channel-agnosticism alone is matched** by Infobip/Sprinklr; (2) **structured flows alone are matched** by LangGraph/Rasa/Cognigy. The moat is the *combination*, not any single axis — and it's a product/architecture head-start, not a network-effect fortress.
