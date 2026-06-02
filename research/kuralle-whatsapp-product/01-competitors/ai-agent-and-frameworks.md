# 01c — AI-agent platforms + developer/durable frameworks (2026)

WhatsApp Cloud API is the only path post on-prem deprecation (Oct 2025). "Native" = vendor runs its own Meta/BSP integration vs. BYO. Enterprise CX pricing is sales-gated (figures are third-party estimates, directional).

## Group A — enterprise CX AI agents
| Product | Pricing (est.) | Agent + SOP style | Durable/exactly-once? | WhatsApp depth | Gap |
|---|---|---|---|---|---|
| **Sierra** | outcome-based; ~$150–350K/yr [1][5][8] | tool-calling + RAG; structured skills (proprietary) | not documented (uncertain) | managed/abstracted | closed, costly, not code-first |
| **Decagon** | ~$50K + per-conv/res; $95–590K [11][12] | playbooks (structured) | not documented | likely BSP (unconfirmed) | opaque, not dev-extensible |
| **Cognigy** | usage-tiered; ~$115–300K [13][16] | **best structured-flow builder** in A + gen agents | not documented | **native** WA Cloud API endpoint: templates+24h-window+interactive [21][27] | closed SaaS, durability-opaque |
| **Parloa** | ~$300K floor [19] | voice-first, structured + scripting | not documented | supported; depth undocumented | very high floor, voice-centric |
| **Ada** | per-resolution ~$1–3.50 [28][33] | playbooks | not documented | first-class omnichannel | per-res cost; not code-first |
| **Intercom Fin** | **$0.99/resolution** (transparent) [36][37] | prompt+Actions (less structured) | not documented | first-class Intercom channel (+~$29/mo) | weaker structured SOP; framework-less |
| **Salesforce Agentforce** | $2/conv or Flex credits [49][50] | Topics + **Salesforce Flow** (real graph) | platform-backed; no external replay guarantee | via Digital Engagement (depth unconfirmed) | heavy lock-in, cost stacking |

## Group B — developer frameworks / durable infra
| Product | Pricing | Agent + SOP | **Durable / exactly-once** | WhatsApp | Gap |
|---|---|---|---|---|---|
| **Botpress** | free→$2k+/mo + msg/LLM [62][67] | LLMz tool-calling + visual flow + autonomy | managed sessions; **no** documented exactly-once | first-class (1-click) [62][68] | cost model; durability-opaque |
| **Voiceflow** | free→$150/mo + credits [55][61] | strong visual graph SOP | **no** durable-replay | supported channel | credit cliffs; not code-first |
| **Rasa (CALM)** | OSS free; Pro ~$35K+ [69][71] | **LLM-routed structured Flows**, OSS, code-first | trackers persist; **no exactly-once** | connectors exist; **DIY** template/window depth | OSS in transition; WA not turnkey |
| **Vapi** | usage ~$0.30/min [73][77] | prompt+tools (voice) | no | voice-only, no WA messaging | out of scope for text WA |
| **LangGraph** | OSS + cloud | **explicit graph FSM, code-first** | **checkpointed resumable** (Postgres/Dynamo); exactly-once tool effects **NOT automatic** [86][89] | **none** (BYO channel) | durable but no channel; soft exactly-once |
| **Temporal** | self-host free; Cloud $200–2k+/mo [80][84] | orchestrates code (not LLM) | **gold standard: exactly-once + replay** [80] | **none** (pure infra) | no flow/channel/LLM primitives |
| **Inngest** | free→~$75/mo [docs] | durable steps (not LLM) | **yes: per-step memoized, retries** | **none** | no conversation/channel layer |
| **Restate** | OSS (BSL runtime) | durable workflows + virtual objects | **yes: journaled replay, exactly-once** | **none** | younger; no flow/channel |
| **Vercel AI SDK** | OSS free | tool loop + `needsApproval` HITL (v6) | **none** (stateless) | **none** | model/tool layer, not a runtime |

## Synthesis — the decisive finding
**(1) WhatsApp protocol handling in CX agents:** only **Cognigy** surfaces WhatsApp (templates/window/interactive) as developer-addressable primitives [21][27]; everyone else (Intercom, Salesforce, Ada, Sierra, Decagon, Parloa) **abstracts it behind a closed managed/BSP layer** the buyer doesn't control.

**(2) Durable resumable run-state + first-class WhatsApp depth — combined? NO.** The durability champions (Temporal, Restate, Inngest = true exactly-once/replay; LangGraph = checkpointed threads, soft exactly-once) have **zero native WhatsApp** (BYO channel). The WhatsApp-deep products (Cognigy, Intercom, Ada, Botpress, Voiceflow) are managed SaaS with **no documented Temporal-style durability or exactly-once tool execution**. **Nobody ships the union.** Closest single product = Cognigy (deep WA + flows) but closed + durability-opaque; closest assembly = "Temporal/Restate + a BSP + your own flow engine" (you build it).

**(3) SOP-in-structured-flows leaders:** Cognigy, Salesforce Flow, Voiceflow (visual); LangGraph, Rasa CALM (code-first). Prompt-leaning: Intercom Fin, Vapi, Vercel AI SDK.

**The triple intersection — durable-state FSM (exactly-once/replay) + native WhatsApp depth (templates/24h-window/interactive) + code-first structured flows — is EMPTY in 2026.** LangGraph = FSM+code-first but no channel + soft exactly-once; Cognigy = channel+flows but closed/non-durable; Temporal = durability but no flows/channel. That intersection is precisely Kuralle's engine — and Kuralle's exactly-once is **automatic** (the effect log), not "depends on your node design" (LangGraph) or "build it yourself" (Temporal+BSP).

## Sources (numbered as in agent report)
1,5,8 Sierra · 11,12 Decagon · 13,16,18 Cognigy pricing · 21,27 Cognigy WA endpoint + Meta docs · 19,20 Parloa · 28,33 Ada · 36,37,44 Intercom Fin · 49,50,54 Agentforce · 55,61 Voiceflow · 62,67,68 Botpress · 69,70,71 Rasa · 73,77 Vapi · 80,84 Temporal · 86,89,90 LangGraph durable-execution · Inngest docs · Restate docs · 6 Vercel AI SDK 6 / github.com/vercel/ai. (Full URLs in `sources.md`.)

**Uncertainty:** all SaaS-CX durability/exactly-once postures are *undocumented* → flagged "not documented," not asserted absent; enterprise pricing is directional.
