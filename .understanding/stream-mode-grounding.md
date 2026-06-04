# Understanding — Stream-mode resolution & the "whole-answer grounding gate" signal

**For:** Streaming-by-default RFC, Sprint 0 / S0-03 (`resolveStreamMode`).
**Question:** What attached gates/signals make a flow reply node require BUFFERING the whole answer (`turn` mode) vs. being safe to stream (`token`/`sentence`)? How should `nodeHasWholeAnswerGroundingGate(ctx, node)` be defined in the *current* codebase?
**Confidence:** high (all claims cite primary source read in full).

---

## Primitive (one line)

A node must buffer (`turn` mode) iff some attached gate's decision depends on the **complete** assistant answer — and in this codebase every such gate is realized through `ctx.validationPolicies` (whole-answer `validate(...)`), with `ReplyNode.confidenceGate` as the one node-level *declaration* of that dependency.

## Map at a glance

- The post-turn gate is `applyPostTurnPolicies(ctx, assistantOutput, toolCallsMade, citations)` — `runtime/policies/agentTurn.ts:236-272`. It runs **output processors** then **validation policies**, both over the *whole* `assistantOutput`.
- **Output processors** (`ctx.outputProcessors: OutputProcessor[]`, `types/processors.ts:43-52`) — may `block` (replace w/ safe message) or `modify` (rewrite). Run at `agentTurn.ts:246-266`.
- **Validation policies** (`ctx.validationPolicies: ValidationCapability[]`, `capabilities/ValidationCapability.ts:4-8`) — may `block`/`escalate`/`rewrite` the whole output. Run at `agentTurn.ts:138-204`.
- The **H6 grounding/confidence gate is a `ValidationCapability`** (state-grounded `validate`, reads `ValidateInput.state` — `ValidationCapability.ts:16-22`). It lives in `ctx.validationPolicies`. There is **no** separate node-attached grounding-gate object.
- `ReplyNode.grounding` (`NodeGrounding`, `types/flow.ts:27-38,56`) is **retrieval/memory scoping only** (W3). Consumed solely by `resolveNodeGatherScope` → gather phase (`runtime/grounding/nodeScope.ts:5-19`). It is **not** a blocking output gate and by itself does **not** require buffering.
- `ReplyNode.confidenceGate` (`{min,onLow}`, `flow.ts:57-58`) reroutes the flow to `onLow` when the post-turn validated confidence is below `min` — `flow/runFlow.ts:227-246` (`turn.confidence < node.confidenceGate.min`). `turn.confidence` originates from `runValidationPolicies`' `lastConfidence` (`agentTurn.ts:156,170,203` → `TurnResult.confidence`).

## Answers to the 5 questions

1. **Composition** — `applyPostTurnPolicies` (`agentTurn.ts:236-272`): output processors first (`runOutputProcessors`, block→safe message early-return at `:258-264`, else `current = outcome.text`), then `runValidationPolicies(ctx, userMessage, current, toolCallsMade, citations)` (`:271`). Validation policies sorted by name (`:154`), folded serially; `block`/`escalate` early-return a safe message + control, `rewrite` mutates `current`, `continue` passes. All operate on the **complete** answer.

2. **H6 gate realization** — It is a **`ValidationCapability`** in `ctx.validationPolicies` (confirmed by `ValidateInput.state` being the H6 grounding signal, `ValidationCapability.ts:16-22`; memory `project_acme_prod_hardening`). **Not** a separate node-attached object. ⇒ already counted by `resolveStreamMode`'s `validationPolicies` term.

3. **`ReplyNode.grounding`** — retrieval/memory scoping (`NodeGrounding`, `flow.ts:27-38`). Grep proves it is read **only** at `nodeScope.ts:10` (gather scope); no runtime/flow path treats it as a blocking gate. **Does NOT by itself require buffering.** Forcing `turn` on it would defeat the RFC latency win for every knowledge-grounded node.

4. **`ReplyNode.confidenceGate`** — depends on `turn.confidence`, the **post-turn validated** confidence (`runFlow.ts:227-230`). The decision needs the whole-answer confidence ⇒ conceptually a whole-answer dependency ⇒ the node-level signal to force `turn`. Caveat: `turn.confidence` is only populated when validation policies ran (`agentTurn.ts:146-148` returns no confidence when `policies.length === 0`), so today confidenceGate is *practically subsumed* by the validationPolicies term — but it remains the explicit node-level declaration.

5. **`ResolvedNode` shape** — carries the node via `ResolvedNode.node: FlowNode` (`types/channel.ts:6-13`), **not** flattened. `grounding`/`confidenceGate` live on the `ReplyNode` variant, so the predicate must reach through `node.node` and narrow on `kind === 'reply'`.

## Decision: `nodeHasWholeAnswerGroundingGate` definition

```ts
function nodeHasWholeAnswerGroundingGate(_ctx: RunContext, node: ResolvedNode): boolean {
  return node.node.kind === 'reply' && node.node.confidenceGate != null;
}
```

- **Key on `confidenceGate`** — the node-level declaration of whole-answer (confidence) dependence.
- **Do NOT key on `node.grounding`** — pure retrieval scoping; gating on it kills the latency win.
- The H6 grounding gate itself needs no special term: it is a `ValidationCapability` and is counted by the `ctx.validationPolicies` arm of `resolveStreamMode` (defaults to `turn` since it won't declare `streamGranularity` — REQ-5).

This satisfies REQ-4's three contributors (`outputProcessors`, `validationPolicies`, node grounding gate) faithfully while matching code reality.

## Top-down ↔ bottom-up reconciliation

Both passes agree: the only buffer-forcing decisions are whole-answer `validate`/`process` outcomes, all routed through `ctx.{outputProcessors,validationPolicies}`; the node layer contributes only `confidenceGate` as an explicit whole-answer hook. No divergence.

## Open question (non-blocking)

- The RFC §4.3/§7 lists `nodeHasWholeAnswerGroundingGate` as a third contributor; in the current codebase it is *largely subsumed* by the `validationPolicies` term. We keep it (keyed on `confidenceGate`) for faithfulness and forward-safety. **No RFC amendment required** — the RFC left the predicate body unspecified; S0-03 specifies it. If review disagrees, the alternative is to drop the third term and amend §4.3/§7 in the same PR.

## Key files (ranked)

| File | Role | Confidence |
|------|------|------------|
| `runtime/policies/agentTurn.ts:236-272` | post-turn gate composition | high |
| `capabilities/ValidationCapability.ts:4-35` | validation policy / H6 gate shape | high |
| `types/processors.ts:43-52` | output processor shape | high |
| `types/flow.ts:27-38,49-60` | NodeGrounding + ReplyNode (grounding, confidenceGate) | high |
| `flow/runFlow.ts:227-246` | confidenceGate consumes post-turn confidence | high |
| `runtime/grounding/nodeScope.ts:5-19` | node.grounding = gather scope only | high |
| `types/channel.ts:6-13` | ResolvedNode.node (reach-through) | high |
| `types/run-context.ts:65-67` | ctx.validationPolicies / outputProcessors | high |
