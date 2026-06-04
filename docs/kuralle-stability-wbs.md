# Kuralle conversational-stability WBS (text-first)

Derived from `docs/kuralle-stability-rootcause.md` (multi-source root-cause workflow, 2026-06-04) + the kapruka red-team. **Decision: TEXT is the primary primitive — voice is cascaded over text later, so voice-only root causes are deprioritized.** Rank-1 verified in code by hand.

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
