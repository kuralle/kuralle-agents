# 01b — Omnichannel / visual-flow-builder platforms (2026)

Note: **WhatsApp Flows** (Meta's native in-chat multi-screen forms) ≠ a vendor's own "flow builder." Most SMB builders confirm the latter, not the former.

| Product | Positioning | Pricing | WhatsApp depth | Same-bot across channels? | AI depth | Gap |
|---|---|---|---|---|---|---|
| **ManyChat** | SMB/creator, social-DM-first | free→~$69/mo by contacts + Meta passthrough [1] | templates + "send outside 24h window" node (guardrail, choose-right-node); buttons/lists; Meta Flows authoring unconfirmed | **per-channel rebuild** | bolt-on (Intention/AI Step, +$29) | per-channel dup; window-safety on user |
| **Chatfuel** | SMB Meta-first | $69→$359/mo per-conv | API, templates; one plan WA+IG+TikTok+web; Flows authoring unconfirmed | partial | bolt-on ChatGPT as engine | thin enterprise; no durable state |
| **Landbot** | SMB/mid web+WA | €40–400 + separate WA track [9] | window handled; buttons/forms; **best visual editor**; Meta-Flows authoring unconfirmed | **per-channel rebuild** | rule-flow + GPT AI Steps | per-channel; pricing complexity |
| **Respond.io** | mid omnichannel (10+ ch) | $79–219+/mo MAC | template library **+ approval-status tracking**; **Meta Flows NOT supported (open request)** [15] | **agent channel-agnostic**, config per channel | **native agent** (RAG, CRM, book) | no Meta Flows; MAC cost; no durability guarantee |
| **Tidio** | SMB web-chat-first | free→$59 then 12× cliff $749; Lyro+Flows metered separately [17] | WA = a channel; window/Flows basic | per-channel scoped | Lyro native NLU (FAQ deflection) | triple-metering; shallow WA |
| **Twilio (Studio/Flex)** | dev CPaaS | ~$0.005/msg + Meta fee; Flex bundles [19] | templates + status APIs; **native Meta Flows** [25]; **24h window NOT auto — free-form → error 63016, dev must fall back** [21] | only as you code it | **none native** (BYO LLM + Copilot assist) | window-safety entirely on dev; ephemeral runs |
| **Sendbird** | dev comms API → AI | MAU $399–599+; Chat/Calls/AI separate buckets [26] | WA API + campaign/template; Meta Flows limited/unconfirmed | API-level | **native AI agents** (RAG) | SDK-heavy; MAU cost; WA/Flows trails Infobip |
| **Infobip** | enterprise CPaaS + AgentOS | per-msg + 3-part AgentOS fee [30][31] | **strongest**: template lifecycle/status APIs, **native Meta Flows fully supported** [32]; **"build once, deploy across WA/Viber/Messenger/RCS/SMS via one API"** [33] | **YES — truly channel-agnostic** | native AgentOS (RAG, guardrails, routing) | opaque 3-part pricing; enterprise complexity; no published durability guarantee |
| **Sprinklr** | enterprise CCaaS/CXM | sales-only ~$2k+/mo [39] | WA templates/CTAs; **native Meta Flows** [36]; **one agent retains context across channels** [37] | **YES — cross-channel context** | native enterprise agent (RAG, governance) | opaque pricing; heavyweight; no durability guarantee |

## Synthesis
**Same bot across channels — two camps.** SMB/marketing builders (ManyChat, Chatfuel, Landbot, Tidio) are **channel-shaped — you rebuild the flow per channel** even with a unified inbox. The CPaaS/enterprise tier inverts it: **Infobip** ("build conversational logic once, deploy across WA/Viber/Messenger/RCS/SMS through the same API") and **Sprinklr** (one agent, context across channels) are genuinely channel-agnostic. Respond.io/Sendbird: the *agent* is channel-agnostic, channel config persists. Twilio: only as you code it. → **Channel-agnosticism is REAL vs SMB builders but MATCHED by enterprise CPaaS — not a standalone moat.**

**Closed-window / template safety.** **Nobody makes a closed-window free-form leak structurally impossible.** Meta enforces the rule downstream; choosing the right send sits with the user/dev — ranging from "a node you might pick wrong" (ManyChat/Landbot) to "a runtime error you must handle" (Twilio 63016). → **Window-safety-by-construction is genuinely unoccupied.**

**Durable-state / reliability — the blind spot.** None of the nine publish a durable-execution or exactly-once-tool guarantee; runs are treated as ephemeral orchestration; survival-across-restarts + idempotent side-effects are pushed to the integrator. → **Confirms the durability white space.**

**Biggest gap (agent verdict):** the absence of a **durable, channel-agnostic conversation runtime that combines exactly-once tool execution with structural closed-window safety.** Today you pick channel-agnosticism (Infobip/Sprinklr) OR code-level control (Twilio) — but window-safety + durability remain the developer's burden everywhere.

## Sources
[1] featurebase.app/blog/manychat-pricing; manychat.com/pricing · [9] landbot.io/pricing · [15] respond.canny.io/.../whatsapp-support-for-whatsapp-flows · [17] tidio.com/pricing; chatarmin.com/en/blog/tidio-pricing · [19] twilio.com/en-us/whatsapp/pricing · [21] twilio.com/docs/api/errors/63016 · [25] twilio.com/docs/content/whatsapp-flows · [26] sendbird.com/pricing/chat · [30] infobip.com/whatsapp-business/pricing · [31] infobip.com/agentos/pricing · [32] infobip.com/docs/whatsapp/whatsapp-flows · [33] infobip.com/blog/whatsapp-chatbot-quick-guide · [36] sprinklr.com/help/.../whatsapp-flows · [37] sprinklr.com/products/platform/ai-agents · [39] retellai.com/blog/conversational-ai-platforms (full list in `sources.md`).

**Uncertainty:** native Meta-Flows *authoring* inside ManyChat/Chatfuel/Landbot/Tidio/Sendbird unconfirmed; Sprinklr/Sendbird pricing third-party; durability assessment is absence-of-evidence (no vendor publishes a guarantee), not a tested claim.
