# ADR 0003 — Out-of-band control evaluator (H1 / W2 keystone)

**Status:** Proposed — **Revision 1** (post external review, kimi-k2.6). Implementation gated on final sign-off.
**Context:** the hardening plan (H1, the keystone) and ADR 0002. Builds on shipped H2 (`ctx.controlModel`, 0.3.12) and H3 (turn lock, 0.3.13).
**Review:** external review (kimi-k2.6) — verdict "not ready" on the v0 design; the revision below resolves its four blockers. **See "Revision 1" at the bottom — it supersedes parts of the original draft above it.**

## Context — control is fused into generation

Today a reply turn decides *what to say* and *what to do next* in the **same** LLM generation pass, and the "what to do next" is recovered **after** the model has already spoken:

1. **One merged tool dict.** `TextDriver.resolveTools` (`TextDriver.ts:184-200`) merges `this.toolDefs + ctx.globalTools + node.localTools + node.tools` into one `aiTools` dict handed to `streamText` (`TextDriver.ts:59-66`). Control tools (handoff / final / escalate / recover) sit in the **same** dict as the node's data tools, and other nodes' tools can leak in. The model chooses control by *calling or not calling* a tool in free-form generation.
2. **Control recovered post-hoc, from the tool result.** Each tool result is run through `classifyControl` (`classifyControl.ts`) via `executeModelToolCall`, and `out.control ??= control` (`TextDriver.ts:116`). Whether the turn hands off / ends / escalates is *whatever the model happened to call* — an un-called control is structurally invisible; a narrated-but-not-called action ("I've transferred you") ships as text with no transition.
3. **Transition computed after the text is committed.** In `runFlow.dispatchNode` (reply path, `runFlow.ts:126-153`): `appendAssistantMessage(turn.text)` runs, **then** `turn.control` is checked, **then** `node.next(turn, state)`. The user-facing text is already finalized before any transition decision — an illegal/contradictory transition cannot re-prompt or downgrade the reply.
4. **Routing is generation-adjacent and entry-only.** `selectHostTarget` (`hostLoop.ts:48`) runs only when `activeFlow` is undefined.

This is **Root Cause 1** (the keystone): the control decision is coupled to free-form generation, so it inherits the model's nondeterminism and provider variance (the gpt-4.1-mini-vs-gemini-3.1-flash-lite control-crash gap). H2 pinned the *control-path LLM calls* to temperature 0; H1 removes control from the *generation* pass entirely.

## Decision — a `ControlEvaluator` the driver calls *separately* from generation

Generation produces a **draft + structured signals**; a separate evaluator decides the transition from those signals, **before** the text is committed. The model can no longer pick the control action, narrate an un-called action, or skip a control step.

### 1. The seam (interfaces)

```ts
// Structured signals the evaluator decides from — NOT free-form text.
interface ControlSignal {
  node: FlowNode;
  draftText: string;            // generated, NOT yet emitted
  toolResults: ToolResult[];    // data-tool results this turn (shape-inspectable)
  state: FlowState;
  latestUserText: string;
  finishReason: string;
}

type ControlDecision =
  | { kind: 'transition'; transition: Transition }   // from node.next-as-predicate or a code rule
  | { kind: 'handoff'; to: string; reason?: string }
  | { kind: 'end'; reason: string }
  | { kind: 'escalate'; reason?: string }
  | { kind: 'recover'; reason?: string }
  | { kind: 'stay' }
  | { kind: 'reask'; reason: string };               // illegal/contradictory → downgrade, don't ship

interface ControlEvaluator {
  evaluate(signal: ControlSignal, ctx: RunContext): Promise<ControlDecision>;
}
```

### 2. Decision precedence (deterministic-first)

1. **Code predicates first** — `node.next(turn, state)` becomes a *pure transition predicate* the evaluator calls (not a post-hoc reader of what the model said), plus state/tool-result shape rules and the existing control-result markers (`classifyControl` logic moves here, fed by tool-result *shape*, not by the model deciding to call a control tool).
2. **Pinned classifier only where genuinely semantic** — when code can't decide (e.g. an open-ended "did the user want to end?"), a temperature-0 call on `ctx.controlModel` (H2), out-of-band, never in the speaking prompt.
3. **Default** — `stay`/the node's static next.

### 3. Per-node tool siloing + minimal node-scoped prompt

The generation `aiTools` contains **only the current node's own data tools** — control tools (handoff/final/escalate/recover) are **not** exposed to the speaking model, and other nodes' tools don't leak in (`resolveTools` gains a control-tool filter, mirroring Pipecat FlowManager's per-node tool set). `composeSystem` stops concatenating control hints into the speaking prompt (the prompt describes the node's *one job*, not routing).

### 4. Pre-emission transition resolution

`runFlow.dispatchNode` (reply, flag-on) reorders to: generate draft → `ControlEvaluator.evaluate` → if `reask`/illegal, re-prompt or downgrade → **only then** `appendAssistantMessage` + emit text + apply transition. The transition is known before the user sees the reply.

## Flag-gated, default OFF (the parity guarantee)

A runtime/agent flag — proposed `agent.experimental?.outOfBandControl?: boolean` (or `HarnessConfig.experimental`). **Default OFF reproduces today's fused path byte-for-byte** (same tool dict, same post-hoc `classifyControl`, same `node.next` timing) — every existing test and the whole W-series stay green untouched. **ON** routes the reply dispatch through the evaluator + siloed tools. The default flips to ON only after the lab validates parity-or-better across all 4 use-cases × 2 providers. This is the de-risking valve the hardening plan called for.

## Increment split (delegated separately, each verified + released)

- **H1a — structural siloing + minimal prompt (flag-gated).** Per-node tool siloing (control tools out of the speaking dict), minimal node-scoped prompt (stop concatenating control hints). No evaluator yet; transitions still resolved as today but from the siloed turn. Acceptance: flag-off byte-identical (all suites green); flag-on, a unit test proves the speaking model never receives control tools.
- **H1b — the `ControlEvaluator` (flag-gated).** Introduce the evaluator + `ControlSignal`/`ControlDecision`; move `classifyControl` onto the tool-result *shape* path inside it; make `node.next` a pre-emission predicate; pre-emission transition resolution. Acceptance: a unit test proves the resolved transition/dispatch text **never reaches the reply** (the W2 acceptance); flag-off byte-identical; lab agents behave identically except improved digression/determinism.

## Consequences

- **Closes Root Cause 1** at its source: control stops inheriting generation nondeterminism; provider variance on the control path drops to what H2 already pins.
- **Unblocks** H4 (constrained-enum decide — the evaluator is its home), H5/W4 (in-flow digression — the evaluator can re-run routing mid-flow), H6 (per-node guardrails/confidence — a pre-emission gate point), H8 (decision traces — the evaluator is the single log site).
- **Cost:** a second (usually code-only, occasionally one temp-0) evaluation per reply turn. Net latency ~unchanged when the decision is code; one extra pinned call only for genuinely semantic decisions.
- **Reuses, doesn't duplicate:** `classifyControl` logic, `node.next`, `Transition`/`NormalizedTransition`, `ctx.controlModel` (H2), the W1 recover/escalate handling (`runFlow.ts:185-209`) — the evaluator routes *into* W1's existing control handling.

## Explicitly deferred (NOT in H1)

Speculative generation; in-flow digression *rerouting* (H5/W4 — H1 only provides the seam); guardrail/confidence classifiers (H6); turn-end prediction (W7, voice). H1 builds the **seam**; later items hang off it.

## Acceptance (whole H1)

- Flag OFF: full suite + lab byte-identical to 0.3.13.
- Flag ON: (a) unit test — the speaking model's tool set excludes control tools; (b) unit test — the transition is resolved before any `text-delta`/`appendAssistantMessage` (dispatch text never reaches the reply); (c) lab (4 use-cases × gemini + gpt) — crashed:false everywhere, behavior parity-or-better vs 0.3.13, with reduced provider variance on decide/routing.
- Core suite green throughout; released as 0.3.14 (H1a) and 0.3.15 (H1b).

## Open questions for review

1. Flag location/name: `agent.experimental.outOfBandControl` (per-agent) vs `HarnessConfig.experimental` (per-runtime)? Per-agent is finer; per-runtime is simpler to flip. **Proposed: per-agent.**
2. `node.next`-as-predicate: keep the current `(turn, state) => Transition` signature (the evaluator passes a synthesized `turn` with the draft) to avoid an authoring breaking change? **Proposed: yes — no author-facing API change.**
3. Is H1a worth shipping alone, or fold both into one flag-gated release? **Proposed: ship H1a then H1b (two releases) per the chosen split.**

---

# Revision 1 — incorporating the kimi-k2.6 review (supersedes the conflicting parts above)

The v0 draft above had a correct *intent* (take control off the free-form generation path) but a wrong *mechanism* (blanket-silo control tools) and a wrong *premise* (that text streams incrementally). The review found four blockers; this revision resolves them.

## Correction 1 — text is ALREADY fully buffered (latency premise was wrong)
`TextDriver.runAgentTurn` accumulates `draftText += part.text` and emits **one** `text-delta` with the final text (`TextDriver.ts:69-70, 139`); VoiceDriver likewise. There is **no incremental streaming today**. Therefore:
- **H1 adds NO time-to-first-token regression** — there is no per-chunk stream to delay. The "buffer-before-emit" worry is moot.
- The real cost is **total-turn latency on the semantic path only**: one extra temp-0 `generateObject` (~150–400ms on gpt-4.1-mini / gemini-flash-lite, extrapolated from `selectHostTarget`). The code-decided path is microseconds.
- **Latency answer (final):** H2 = neutral-to-faster (no extra calls). H3 = <1ms on the normal path (serialization only for genuinely-overlapping same-session requests — the fix, not a regression). H1 = zero added latency when control is code/structured-decided; **+1 temp-0 call only when a decision is genuinely semantic** — and the design below ensures that is NOT every free-conversation turn.

## Correction 2 — separate the control CHANNEL, don't delete the control SIGNAL (resolves A-02, A-03)
The flaw: `classifyControl` reads the *result shape* of a control tool the model called; siloing those tools out makes it dead, and free conversation (no `node.next`) loses its only control signal. Resolution — distinguish the two control sources:
- **Flow nodes:** transitions are the FLOW's job, not the model's. The evaluator derives them from `node.next` / `decide` / tool-result shape / W1 recover-escalate — **deterministically**. A flow reply node's speaking dict carries only its data tools; it does **not** need model-initiated flow-transition control tools. `classifyControl` still runs **on the data-tool results' shape** (a data tool may return a `__handoff`/`__escalate` shape, e.g. W1), so it is NOT dead — it becomes one input to the evaluator.
- **Free conversation (no flow):** the model legitimately IS the only one who can decide handoff/end. Keep a **dedicated, explicit control channel** here (the existing handoff/final tools, or a constrained `__control` output) — NOT mixed into a large data-tool dict, but NOT removed. `classifyControl` interprets its result deterministically. Free-conv falls to the temp-0 classifier ONLY when the model emits ambiguous prose with no control affordance used — not every turn.

Net: "per-node tool siloing" (Decision 3 above) is **narrowed** to "flow reply nodes don't expose model-initiated *flow-transition* control; routing is the evaluator's job." Free conversation keeps its model control channel. The temp-0 classifier is the *last* resort, not the default.

## Correction 3 — `ControlSignal` must carry `interrupted` (resolves A-04)
Add `interrupted: boolean` (and `truncateAt?`) to `ControlSignal`. The evaluator **bypasses** any transition/handoff/end decision on an interrupted/partial draft (mirrors `runFlow.ts:130-134`) — it must not decide control from half a turn.

## Correction 4 — one flag-gated release, not H1a-then-H1b (resolves A-06)
H1a alone (siloing without the evaluator) is a broken half-state — control becomes structurally unreachable. **Merge: H1 ships as a single default-OFF flag-gated release** (siloing + evaluator + pre-emission resolution together). Released as 0.3.14.

## Resolved open questions
1. **Flag:** per-agent `agent.experimental.outOfBandControl` (per-runtime would force all-or-nothing). ✓
2. **`node.next` signature:** keep it (no author break) — BUT document that under flag-ON, model-initiated `turn.control` inside a **flow** node no longer fires (flow routing is the evaluator's); authors relying on a model handoff mid-flow migrate to a `decide`/`escalate` edge. Free-conv `turn.control` is unchanged.
3. **Split:** folded into one release (Correction 4).

## Flag-OFF parity (resolves A-08)
Default-OFF branches in exactly three places — `resolveTools` (tool dict), `runFlow.dispatchNode` (evaluator vs today's `node.next`/`turn.control`), `composeSystem` (control-hint concatenation). A dedicated **parity test** asserts flag-OFF produces an identical tool set, identical emit sequence, and identical transitions to 0.3.13 on a representative flow — "suite green" is necessary, not sufficient.

## Revised acceptance
- Flag OFF: parity test (tool set + emit sequence + transitions identical to 0.3.13) + full suite + lab byte-identical.
- Flag ON: (a) flow reply node's speaking tool set excludes flow-transition control tools; (b) free-conversation handoff/end still works via the dedicated control channel WITHOUT a temp-0 call; (c) transition resolved before `appendAssistantMessage`/emit; (d) interrupted turn bypasses the evaluator; (e) lab 4×2 crashed:false, parity-or-better, reduced decide/routing variance. Single release 0.3.14.
- Add evaluator-latency masking to H7 scope (interim filler also covers a pending semantic control call).
