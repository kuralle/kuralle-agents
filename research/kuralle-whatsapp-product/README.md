# Research — "Build your next WhatsApp Bot with Kuralle" (final product)

> **RESEARCH ONLY — no build.** Decision-ready strategy artifact: competitor landscape, full-product feature scope (UI-heavy), and a defensible business MOAT, grounded in the Kuralle engagement framework already shipped in this repo (`packages/kuralle-engagement` + `kuralle-messaging` + `kuralle-messaging-meta` + `kuralle-core`).

## The decision this unblocks
Is there a defensible product + MOAT in "Build your next WhatsApp Bot with Kuralle", and what is the full (non-MVP) build scope around our engine? The answer is right only if it: (a) places us honestly in a crowded, partly-commoditized market; (b) scopes the platform/UI work with effort tiers and a what-we-already-have map; (c) names moats grounded in real, hard-to-copy tech with an honest durability verdict each.

## Hypothesis (pre-research, to be tested)
The WhatsApp-bot-builder market is **commoditized at the BSP/marketing layer** (templates, broadcasts, shared inbox — everyone has these, racing to the bottom on per-conversation pricing) and **immature at the AI-agent layer** (LLM is a bolt-on, not a durable, channel-safe, SOP-structured agent). Kuralle's defensible wedge is **not** "another no-code builder" — it's the **engine**: a durable, replayable run-state FSM + a non-removable window-safe outbound pipeline + a channel-agnostic policy abstraction + code-first structured flows. The product should sell the **reliability/correctness + developer-grade agent** angle, not compete on marketing-blast features. **Flip if** research shows a competitor already combines durable-state + native-WhatsApp-protocol-depth + structured-flow agents (then the moat is narrower than thought).

## Folder index
- [`01-competitors/`](./01-competitors/) — landscape (3 segments: WhatsApp-native, omnichannel/builder, AI-agent/dev-framework) + synthesis + commoditized-vs-rare verdict. *(from parallel web research)*
- [`02-capability-inventory.md`](./02-capability-inventory.md) — what the Kuralle engine ALREADY provides, grounded in repo code (file:line). *(firsthand)*
- [`03-feature-scope.md`](./03-feature-scope.md) — full-product feature breakdown (UI + platform + dev surface), each area mapped to have / net-new + effort tier.
- [`04-moat.md`](./04-moat.md) — candidate moats grounded in our tech, each with a durability verdict vs. competitors.
- [`DECISION.md`](./DECISION.md) — TL;DR verdict, positioning, what-to-build-first, flip conditions.
- `sources.md` — numbered citations.

## Status
**COMPLETE.** Competitor web research (3 cited segments) + firsthand capability inventory + feature scope + moat + decision all written. Verdict in [`DECISION.md`](./DECISION.md). Not committed to git (research artifact); say the word to commit.
