# ADR 0001 — Agent base layer (base instructions + global tools) composed into every flow node

**Status:** Accepted (2026-06-04)
**Context owners:** Kuralle core

## Context

A Kuralle flow is a graph of nodes (`collect` / `decide` / `action` / `reply`). Each node turn is run by a `ChannelDriver`, and today the node's **system prompt is its own `instructions` only** (`buildNodePrompt` = `resolveInstructions(node.instructions)`), plus optional RAG/memory gather blocks. The agent's global `instructions` (persona, tone, safety, grounding rules) are used in exactly one place — `buildAgentReplyNode` (`agentReply.ts`), the off-flow/host reply — and are **not** composed into in-flow nodes.

Two problems follow:

1. **No shared persona/safety floor.** Each in-flow node behaves like a standalone mini-agent. Global grounding/safety rules placed on `agent.instructions` do not reach `welcome`, `giftCard`, `orderConfirm`, etc. In the acme concierge this is exactly why prompt-level grounding had to be duplicated per node, and why a sparsely-instructed reply node (`noResults`) still drifted into "visit the website".
2. **No always-available tools.** A node can only call the tools it declares. There is no way to make a safe, cross-cutting capability (a returns/FAQ knowledge-base lookup) callable from anywhere a user might ask for it mid-flow.

ElevenLabs' ElevenAgents orchestration does the opposite and it is the better shape: a base system prompt + core tools + global knowledge are **always present regardless of the active node**, and each sub-agent **layers** its own instructions on top ("prompt composition"), with the orchestrator rebuilt per transition. See `reference_elevenlabs_orchestration` and `docs/solution` prior art.

## Decision

Introduce an **agent base layer** composed into every flow-node turn:

1. **Base instructions.** The agent's `instructions` are composed as a prefix to every node's system prompt, for all node turns that build a system prompt (`runAgentTurn`, `runStructured`, `runExtraction`). Final system = `[baseInstructions, nodeInstructions, gatherBlocks].join("\n\n")`. Node instructions **layer on top of** (never replace) the base. This is a behavior change: existing apps' node turns will now also carry the agent persona/safety — which is the intended, ElevenLabs-aligned behavior.

2. **Global tools.** A new, explicit `AgentConfig.globalTools?: Record<string, AnyTool>` names a **designated, safe subset** of tools that are model-visible in every **speaking** turn (`runAgentTurn`), so e.g. `faq_lookup` is callable wherever the agent talks. Threaded via `RunContext.globalTools`.

   **Safety invariant:** global tools are an explicit allow-list, NOT all `effectTools`. Consequential/mutating tools (e.g. `create_order`) MUST NOT be global — they stay flow-gated. Global tools are **not** exposed during silent `collect` extraction (extraction remains submit-tool-only and non-speaking, per ADR-implicit 0.3.5).

Threading: `Runtime.run` sets `ctx.baseInstructions = agent.instructions` and `ctx.globalTools = agent.globalTools` after `createRunContext`; `hostLoop` already carries the agent. Drivers resolve `baseInstructions` against current state per node (so state-dependent prompts still work).

## Consequences

- **Pro:** one consistent persona/safety/grounding floor across every node (closes per-node drift, including the reply-node "visit website" residual); a clean home for always-available capabilities (returns/FAQ KB) without per-node wiring; matches ElevenLabs' proven model.
- **Con / risk:** behavior change — node prompts get longer (base + node); base text counts toward every node's tokens. Mitigation: keep the base prompt tight (persona + safety + grounding only; procedure stays in flows per the "SOP lives in flows" rule). Global tools enlarge speaking-turn tool schemas; keep the allow-list small.
- **Migration:** additive. Apps with no `globalTools` are unaffected except that `agent.instructions` now also prefixes node prompts (apps that relied on nodes NOT seeing the agent prompt should move that text out of `instructions`).

## Alternatives considered

- **Per-node copy of global rules (status quo).** Rejected: duplicative, drift-prone, exactly what failed.
- **Post-generation contradiction filter.** Rejected as the primary mechanism (can't make voice pre-speech safe; semantic multilingual detection is brittle) — see `opinion-core-backstop`. Kept only as optional defense-in-depth for reply nodes.
- **Expose all `effectTools` everywhere.** Rejected: would let the model call mutating tools (`create_order`) from any node, bypassing flow gates.
