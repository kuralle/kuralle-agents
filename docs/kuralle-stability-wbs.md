# Kuralle conversational-stability WBS (text-first)

Derived from `docs/kuralle-stability-rootcause.md` (multi-source root-cause workflow, 2026-06-04) + the acme red-team. **Decision: TEXT is the primary primitive — voice is cascaded over text later, so voice-only root causes are deprioritized.** Rank-1 verified in code by hand.

## Priority

| ID | Pri | Root cause it fixes | Change | Why now | Status |
|----|-----|---------------------|--------|---------|--------|
| W1 | **P0** | #1 escalation/fallback (CRITICAL, verified) | **Turn-local recovery boundary + `cannot_do`/`escalate` control result.** Wrap `ctx.tool()` in the turn loop so a throw becomes an honest in-turn message + reachable `escalate`→human, never a session abort. Extend `classifyControl` beyond handoff/final. | Only hard-crash in the set; smallest; text-relevant; prerequisite for any action-taking agent. | todo |
| W2 | P1 | #1 keystone (control/generation fusion) | **Split orchestration from generation:** minimal node-scoped prompt for the agent; a parallel/out-of-band evaluator owns transitions + guardrails + routing (don't merge all tools into one dict; don't let `node.next()`/`selectHostTarget` run only after the model spoke). | Unblocks digression (#6), per-node guardrails (#7), determinism (#2). Bigger — sequence after W1. | todo |
| W3 | P1 | #7 grounding | **Per-node context scoping:** `knowledge`/`memory`/query fields on nodes; `runGatherPhase` assembles per-node, query-rewritten — not agent-wide once-per-turn. Additive, lowest-risk. | Directly reduces hallucination; helps determinism. | todo |
| W4 | P1 | #6 digression / multi-intent | In-flow re-routing primitive: let routing re-run inside an active flow; multi-intent parse at the input boundary; stop discarding off-script prose silently. | Real customers digress; needed for support/sales agents. | todo |
| W5 | P1 | #8 repair / correction | Surface collected field values to the extractor; tag new-vs-correction; emit a confirmation on change. | Corrections are table-stakes for collect-heavy flows. | todo |
| W6 | P1 | #5 memory (cross-session/user) | First-class per-user memory + resumption checkpoint (activeFlow/node/pending); optional scheduler/trigger for unattended runs. | "Welcome back" + durable carts; text-relevant. | todo |
| W8 | **P1** | #4 latency masking | Tool execution modes (immediate+filler / post-speech / async) + speculative-generation hook. | **In scope:** this is the layer cascaded voice-over-text rides on (async/post-speech tool dispatch + filler), and it masks model latency in text too. | todo |
| W7 | P2 (defer) | #3 turn-taking/endpointing | Turn-end predictor + local VAD fallback. | **Voice-only** (provider-native realtime owns this) — deferred per text-first decision. | deferred |

## Already shipped this session (related)
- 0.3.5 silent collect extraction (anti-narration) · 0.3.6/0.3.7 agent base layer + global tools · 0.3.1–0.3.4 one-input-per-turn / collect grounding. These are the *virtue* side of the synchronous design (deterministic, no fabricated fields) — W1–W6 add the resilience side without throwing that away.

## Sequencing
W1 (ships now, standalone) → W3 + W5 (additive, low-risk, parallel) → W2 (keystone, larger; enables W4) → W4 → W6 → W8 (tool-modes + speculative gen; the substrate cascaded voice rides on). W7 deferred (voice-native).

---

## Validation update (multi-use-case + provider red-team, 2026-06-04)

Ran the root causes against 4 fresh agents (support_refund, restaurant_booking, sales_qualify, tech_troubleshoot) × {gpt-4.1-mini, gemini-3.1-flash-lite}. Full report: `docs/kuralle-stability-validation.md`. Manager-verified the headline crash (Gemini crashes `support_refund` on "how long to return?" via `faq_lookup(undefined)` at the welcome collect; gpt-4.1-mini clean).

**Confirmed framework-level (not Acme-specific):** W1 crash, W3 grounding, W4 digression, W5-repair all reproduce across all 4 domains.

**Changes to this WBS from the validation:**
- **W1 (P0) reinforced + relocated to the RUNTIME turn loop.** It crashes via THREE paths, not one: (1) `maxOscillations:16` turns a recoverable stuck loop into a hard `SESSION_CRASH`; (2) a model-initiated tool call at an upstream collect node throws *before* any author `try/catch`; (3) a raw throw bubbling past an action-node catch. A per-tool/per-author try/catch is **necessary but insufficient** — the fix is: a `recover`/`escalate` control-result type + an oscillation→degrade-not-crash policy + a recovery boundary around model-initiated tool calls, all in the runtime, plus graceful tool-arg validation (don't let a zod throw kill the session).
- **NEW P0 — W9 mutation-gate reliability.** The confirm-before-mutate gate (a decide node's structured choice) **fails toward mutating** and is provider-fragile: Gemini books on a dessert question, opens a ticket on "no thanks" (4/4), re-mutates a logged lead on any post-END message; gpt fires `create_lead` on a bare number before consent. Fix: mutation gates must require a **deterministic explicit affirmative** (not an LLM-mapped choice), ignore post-END input, and never coerce off-script text into `confirm`. (Couples with W2's out-of-band evaluator owning choice validation.)
- **W6 memory — EXONERATED, dropped.** Cross-turn state is durable in every domain/provider; every apparent "memory loss" was a W4 digression-derailment or post-END flow re-entry, not lost state. Not a root cause.

**Provider verdict (first-class stability variable):** gpt-4.1-mini = 4 crashes total, no fabrication, reliable structured choices, fails *quietly/deterministically* (stale-timing narration). gemini-3.1-flash-lite = 14 crashes, fabricates facts (invented menus/policies), non-deterministic + unsafe choice gates, indisciplined tool-calling. **Default to gpt-4.1-mini until W1 + W9 land; gemini-3.1-flash-lite is not production-safe on Kuralle today.**

**Harness/observability gap to fix:** effect-tool calls inside action nodes don't emit model `tool-call` stream events, so tool discipline was under-observable — instrument before the next red-team.
