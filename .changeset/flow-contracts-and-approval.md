---
"@kuralle-agents/core": major
"@kuralle-agents/messaging": major
"@kuralle-agents/hono-server": major
"@kuralle-agents/cf-agent": major
---

Flow contracts are enforced, human approval is a real decision, and flow state is owned.

## Breaking changes — what a consumer must do

**Flow state is an isolated frame.** A flow no longer reads or writes the run's root state
record. Nothing crosses a flow boundary unless the flow declares it:

```ts
defineFlow({
  name: 'shop',
  state: {
    input: (source) => ({ customerId: source.customerId }),
    output: (state) => ({ orderNumber: state.orderNumber }),
  },
  // ...
})
```

Reading the state of a flow that is still running now goes through the new
`currentFlowState(runState)` export; `runState.state` no longer holds it. Values from a
finished flow appear in the root state only if the flow declared `state.output`.

**Resuming an approval is request-bound.** `SignalDelivery` requires `requestId`, an
`actor`, and — for approvals — a literal `decision` of `'approve'` or `'deny'` with no
payload. The previous `{ approved: true, by: 'someone' }` payload is rejected: it let any
truthy value execute a protected tool, and named its own actor.

`hono-server` and `cf-agent` resume endpoints require the new fields. Both take the actor
from the server, never from the request body, and expose a hook — `resolveSignalActor` —
to bind a real authenticated identity so the audit log can say who decided.

`TurnResult.suspended` is now `{ requestId, signalName }` rather than `{ signalId }`.

**Two kinds of in-flight run cannot be resumed and must be resolved out of band.** Both
refuse by name rather than doing something unsafe:

- one paused on an approval created before approvals were request-bound — its decision
  would otherwise be keyed by call order, which is the property this release removes;
- one still inside a flow whose journal predates flow-scoped effect keys — none of its
  recorded steps would match, so every effect it had already performed would run again.

Runs outside a flow, and runs with nothing journaled, upgrade silently.

Find them before you deploy, not after:

```ts
import { findUnresumableRuns } from '@kuralle-agents/core';

const stuck = await findUnresumableRuns(sessionStore);
for (const run of stuck) {
  console.log(run.sessionId, run.reason, `${run.recordedSteps} effects already run`);
}
```

Each result needs a decision: let the conversation finish on the old version, or resolve
it out of band. There is deliberately no flag to force one through — the two outcomes it
avoids are an approval decided by call order, and a payment or dispatch executed twice.

## Fixes

**An approved operation could be lost forever.** A decision and the operation it authorises
are two durable writes; the request used to be cleared as soon as the decision landed, and
the only consumer of a frozen operation is reached through that request. A crash in between
dropped the approved operation with no error, no audit and no retry. The request now
survives until the operation has run.

**A handed-off agent replayed the previous agent's tool result.** Effect keys carried no
flow, while callsites are rebased to 0 on every flow entry — so two flows in one logical run
calling a same-named tool with the same arguments collided, and the second replayed the
first's result. Live, that made an agent hand off to itself until `maxHandoffs` killed the
run, with the tool executing exactly once for six results.

**Verification ran on one transition kind.** An action's `outputSchema` and verifier were
checked only when it moved to another node — an action that ended the flow, handed off or
escalated skipped its own contract. Verification now runs before any transition is reduced.

**`collect` advertised Standard Schema and implemented Zod.** Required-field discovery
returned nothing for any non-Zod schema, so a collect node could complete with required data
absent. Completion and projection now await the advertised validator over the whole object.

**Runaway nested flows crashed instead of degrading.** Park-stack overflow threw an
unclassified error and escaped `runtime.run()`, while the structurally identical
`maxOscillations` limit degrades cleanly. Now typed and degradable.

**Losing a decision race surfaced an internal error.** Concurrent decisions never
double-executed, but the loser rejected with a store-level conflict instead of reporting
that someone else had already decided.

**Routing and digression model calls were invisible.** They bypassed instrumentation
entirely — no spans, no token accounting, not cancellable. They now share the instrumented
path.

## Also in this release

Per-node tool scope, framework-owned loop exits, and model-call instrumentation.

**`ReplyNode.toolScope`** — a flow node can now narrow what the model sees, instead of only
adding to it. `'open'` (the default, unchanged behaviour), `'base'` (drop the agent's tool
registry, keep the always-available layer), `'closed'` (node tools only). Flow-transition
control tools stay governed by `outOfBandControl` in every scope, so a closed node can still
hand off or escalate. One resolver now serves the reply and extraction paths; the duplicate
`resolveExtractionTools` is gone.

**Fewer model round-trips.** The turn loop previously ended only when the model stopped
asking for tools, so it kept generating after the framework already knew the outcome. Three
measured round-trips removed on an instrumented flow turn: the speaking loop now stops once a
control signal is set (−1,017 ms), extraction stops once the collect node is satisfied
(−1,201 ms), and terminal reply nodes can declare `toolScope: 'closed'` (−1,203 ms). A live
dispatch scenario went from 9 model calls to 6, deterministically across repetitions.

**`llm` trace spans.** `SpanKind` declared `'llm'` but nothing ever opened one, so model
latency and per-call token usage were unmeasurable. New `model-call-start` / `model-call-end`
internal stream parts produce spans parented to the node, carrying model id, token counts and
cache reads. Control-path calls are marked and parent to the turn. Imperative `ctx.tool` calls
from action nodes now emit tool spans — previously they emitted none, so real executions were
invisible in traces.

**Collect recovery is bounded.** A `RecoverableToolError` cleared the collect node's turn
counter along with its data, disarming the only thing bounding the retry loop. Re-supplying
the same correct values reproduced the same error indefinitely. The counter is now preserved,
so `maxTurns` terminates the loop as intended.

**Tool dispatch sees every definition.** `agent.tools` were absent from the execution-side
lookup, so parallel-safety classification saw `undefined` and serialised those calls even when
declared `parallelSafe`. Policy, approval and idempotency were unaffected.
