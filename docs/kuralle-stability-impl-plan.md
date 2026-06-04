# Kuralle stability — consolidated implementation program

Delegate-ready, sequenced. One chunk = one `@kuralle-agents/core` patch (version bump + republish) verified against the core test suite AND a live re-run of the `kuralle-suite/kuralle-redteam-lab` agents. ADR: `docs/adr/0002`. Root cause: `docs/kuralle-stability-rootcause.md`; validation: `docs/kuralle-stability-validation.md`. Manager (me) writes each brief + verifies each PROCEED before the next; cursor implements.

## Order & status

| # | Pri | Title | Depends | Status |
|---|-----|-------|---------|--------|
| W1 | P0 | Runtime recovery boundary (errors degrade, never abort) | — | **in progress** |
| W9 | P0 | Deterministic mutation/confirm gate | — | queued |
| W3 | P1 | Per-node context scoping (KB/memory/query) | — | queued |
| W5 | P1 | Observable repair/correction in collect | — | queued |
| W2 | P1 | Split orchestration from generation (keystone) | — | queued |
| W4 | P1 | In-flow digression / multi-intent routing | W2 | queued |
| W8 | P1 | Tool execution modes (immediate+interim / post_speech / async) | — (W8b speculative needs W2) | queued |
| W7 | P2 | Endpointing / turn-end prediction | — | deferred (voice) |

## Per-chunk implementation spec

### W1 — Runtime recovery boundary (errors degrade, never abort)
**Goal:** a tool exception, a `ToolValidationError` (bad args), or a `maxOscillations` cap must NEVER abort the session; instead degrade in-turn (safe message + `error`/`tool-error` event) and route to `escalate` (or graceful end + park).
**Files:** `runtime/channels/TextDriver.ts` + `runtime/channels/extractionTurn.ts` + `runtime/channels/VoiceDriver.ts` (wrap each `ctx.tool(...)` in try/catch → push a `{error}` tool result + emit a non-fatal `error` part + continue); `flow/runFlow.ts` (catch node/action throws → route to `escalate` if reachable else graceful end + safe message; `maxOscillations` cap at line ~220 → graceful degrade, NOT `throw FlowOscillationError`); `flow/classifyControl.ts` + `types/channel.ts` (add a `recover`/`escalate` `TurnControl`); `runtime/Runtime.ts` (turn-level tool/oscillation errors degrade gracefully, never reject the run handle). Keep the durable effect-log exactly-once semantics intact.
**Acceptance:** lab — `support_refund` on gemini-3.1-flash-lite "how long do I have to return?" → `crashed:false`; `restaurant_booking` party>20 → `crashed:false`; `sales_qualify` budget "TBD" → `crashed:false`; a thrown tool → safe message + escalate/park. Core suite green; regression test: a tool whose execute throws does not abort `runFlow`.

### W9 — Deterministic mutation/confirm gate
**Goal:** advancing past a confirm/mutation gate requires a deterministic explicit affirmative; off-script input never advances; post-END never re-mutates.
**Spec:** a node-level flag (e.g. `confirmGate: true` on decide, or a `mutationGate` helper) whose advance condition is parsed in CODE (explicit yes/confirm tokens incl. SI/TA), not via the LLM choice; ambiguous/off-script → re-ask or route to clarify, never `confirm`; once a flow has ended, a new message starts fresh (no re-mutation of completed state).
**Acceptance:** lab — booking does NOT book on a dessert question or "no thanks"; sales does not `create_lead` on a bare number without an explicit yes; post-END message does not re-mutate. Core suite green.

### W3 — Per-node context scoping
**Spec:** optional `knowledge`/`memory` fields on `ReplyNode`/collect/decide; `runGatherPhase` assembles per-node (node-scoped query rewrite over history) instead of agent-wide once-per-turn. Additive; no behavior change when unset.
**Acceptance:** a node with a scoped KB retrieves a node-specific answer; nodes without the field behave as today; core suite green.

### W5 — Observable repair/correction
**Spec:** surface currently-collected field values to the extraction prompt; tag new-vs-correction; emit a confirmation when a previously-given field changes.
**Acceptance:** give a field then correct it → the correction is honored AND acknowledged; core suite green.

### W2 — Split orchestration from generation (keystone)
**Spec:** minimal node-scoped generation prompt; a separate evaluator owns transition conditions + guardrails + routing (don't merge all tools into one dict; don't run `node.next()`/`selectHostTarget` only after the model spoke). Likely behind a flag initially. Largest chunk.
**Acceptance:** transitions decided out-of-band (a unit test proves dispatch text never reaches the reply); core suite green; lab agents unchanged behaviorally except improved digression.

### W4 — In-flow digression / multi-intent (needs W2)
**Spec:** let routing re-run inside an active flow (answer off-script then resume); multi-intent parse at the input boundary; stop discarding off-script prose silently.
**Acceptance:** lab — an off-script question mid-flow is answered then the flow resumes; two intents in one turn both handled.

### W8 — Tool execution modes
**Spec:** add `mode?: 'immediate'|'post_speech'|'async'` to the effect `Tool`; consolidate the duplicate `tools/Tool.ts` `filler`/`estimatedDurationMs` into the canonical `interim`/`interimAfterMs`; wire the TextDriver loop (immediate→emit interim before awaiting; async→don't block, await at run-end on the effect log; post_speech→run after text emitted). W8b speculative generation deferred to after W2.
**Acceptance:** slow tool + interim → interim text-delta before result; async tool → turn completes without awaiting, effect log records once; post_speech → text before tool runs.

## Verification loop (every chunk)
1. cursor implements in `packages/kuralle-core` + adds regression tests.
2. Manager reads the diff, runs the core suite + dependents (engagement/hono), bumps the graph + republishes, bumps the lab to the new version.
3. Manager re-runs the relevant `kuralle-redteam-lab` agents live (both providers) to confirm the acceptance criteria.
4. PROCEED → next chunk.
