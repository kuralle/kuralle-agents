---
"@kuralle-agents/core": minor
---

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
