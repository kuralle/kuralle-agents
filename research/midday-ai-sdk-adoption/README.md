# Midday AI-SDK Tooling — Adoption Decision

**One-line verdict:** Adopt **nothing as a dependency**; **port two patterns now** (`ai-sdk-heal` pairing-integrity + `hyper` MCP-projection), study the rest. The midday/Vercel-AI-SDK tool ecosystem independently converged on ideas kuralle already ships better — its value is *validation* plus three small, kuralle-shaped patches.

## What kuralle is choosing

Whether to take a dependency on, vendor source from, or port the idea from eight AI-SDK-native libraries (seven from the midday/`ai-sdk-tools` orbit, one — `toolpick` — adjacent) into `@kuralle-agents/core` and its runtime. The decision is **not** "are these good libraries" — most are. It is "does this close a *live* kuralle gap, at a structural seam kuralle actually has, without regressing the three invariants kuralle just shipped."

## Blast radius (what a wrong adoption breaks)

Three recently-shipped invariants are the blast radius every candidate is scored against:

1. **0.7.2 prompt-cache prefix stability** — Anthropic `cache_control` over the system+tools prefix + OpenAI `promptCacheKey`, measured ~50% input-cost cut on turns 2–4. Anything that mutates the system/tools/message prefix *per step* or *after* `applyPromptCache` (promptCache.ts:197, called TextDriver.ts:78) silently forfeits the cache. This kills `toolpick`'s `prepareStep` form and `ai-sdk-heal`'s `withHealing` middleware form.
2. **ADR 0007 multilingual / no-lexical-routing** — `deterministicRouteMatch`/`keywordRouteFallback` were *deleted* because `toLowerCase().includes()`/regex break multilingual voice. `ai-sdk-agents`' `matchOn` and `toolpick`'s BM25 default re-introduce exactly that banned surface.
3. **Durable-tool exactly-once** — the effect log (ToolExecutor.ts, keyed by `toolCallId` at :93) owns exactly-once-on-retry. `ai-sdk-cache` cross-`toolCallId` caching, `ai-sdk-heal`'s `stub-result` fabricated tool-result, and an unkeyed MCP `tools/call` boundary each threaten it.

## Rubric (how each candidate was scored)

| Axis | Question |
|---|---|
| **solves-real-gap** | Is the gap LIVE in kuralle today, or latent/already-solved? |
| **kuralle seam** | Does kuralle have a structural plug-point, and is it the *same* one the lib uses? |
| **license** | Full LICENSE text shipped? (manifest-only MIT = port-the-idea-only; no license = adopt-BLOCKED) |
| **invariant safety** | Does it regress prompt-cache / ADR-0007 / exactly-once? |
| **maturity** | Tests present and observed green? |
| **decision** | adopt-lib / port-pattern / study-only / skip |

The licensing rule is hard: **only `ai-sdk-heal` and `hyper` ship full MIT LICENSE text** (both verified firsthand). Every `ai-sdk-tools/*` package (cache, devtools, artifacts, agents, memory) and `toolpick` assert MIT in `package.json` *only*, with no LICENSE file — and `ai-sdk-memory` has no license field at all (adopt-BLOCKED outright). So for six of eight, "adopt the code" was never on the table; the live question for those is port vs study.

## Folder index

- **`prior-art/clones/`** — the eight source clones (gitignored). Read verbatim, not from README/memory.
- **`prior-art/docs/`** — eight firsthand inspection docs (one per candidate): real signatures, license verification, core mechanism, maintenance signals, verbatim load-bearing snippets, kuralle relevance.
- **`05-decision/adoption-plan.md`** — **the core artifact**: ranked comparison table, per-candidate opinionated verdict, sequenced ship plan, flip conditions, and the two cross-cutting tensions analyzed.
- **`BUILD-READY.md`** — for the #1 and #2 adoptions: green-light check + the literal first 3 commits (files + intent), grounded in kuralle's real seams.
- **`01-libraries/`** — (reserved) raw library notes.

## Hypothesis going in vs verdict coming out

- **Hypothesis:** "midday's AI-SDK tools are a fast path to fill kuralle's tooling gaps — adopt the best 2–3 as deps."
- **Verdict:** Falsified for adoption, confirmed for *direction*. Every transferable idea is either already in core (handoff-as-tool, working memory, custom data-parts) or a small kuralle-shaped patch (pairing-integrity, MCP projection, tool-result cache). Adopt-as-dependency is blocked by licensing (6/8) and structural mismatch (the libs wrap the AI-SDK `Tool.execute`/`prepareStep` layer that kuralle's `toolToAiSdk` deliberately strips). **Port two patterns this sprint; the rest are study-only references that validate kuralle was already on the right line.**
