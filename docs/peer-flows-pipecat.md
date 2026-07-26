# Flow engines — Kuralle vs Pipecat Flows

**Date:** 2026-07-26 · **Method:** source read of `pipecat-ai/pipecat` at `src/pipecat/flows/`
(2,019 lines across `types.py`, `manager.py`, `actions.py`, `adapters.py`) against
`packages/core/src/types/flow.ts` and `packages/core/src/flow/`.

**Why now:** Pipecat merged `pipecat-flows` into core. Flows are the area we are betting on,
so the comparison matters more than it did when they were a separate package.

---

## 0. We already borrowed from them

Their `examples/flows/` and ours are the *same set*, name for name: `patient_intake`,
`food_ordering`, `insurance_quote`, `restaurant_reservation`, `warm_transfer`,
`podcast_interview`, `llm_switching`, `hello_world`. Our flow examples were modelled on
pipecat-flows. Worth stating plainly rather than presenting this as independent convergence.

---

## 1. The structural difference: one node type vs four

**Pipecat — one `NodeConfig`, behaviour comes from its `functions` list:**

```python
NodeConfig(
    task_messages=[...],      # required — what this node is for
    role_message="...",       # bot personality
    functions=[...],          # FlowsFunctionSchema | FlowsDirectFunction
    pre_actions=[...],        # run BEFORE llm inference
    post_actions=[...],       # run AFTER
    context_strategy=...,     # APPEND | RESET | RESET_WITH_SUMMARY
    respond_immediately=True, # speak on entry?
)
```

Every node is "here are messages plus functions — the LLM decides." A transition happens
when the LLM calls a function whose handler returns `(result, next_node)`.

**Kuralle — four node kinds, intent encoded in the type:**

| kind | what it guarantees |
|---|---|
| `reply` | model speaks; `next(turn, state)` picks the transition |
| `collect` | **deterministic extraction** against a schema; user-facing copy comes from `ask()`, never the model |
| `action` | **runs code with no model in the loop at all** |
| `decide` | structured choice, with an optional `confirmGate` (confirm / decline / ambiguous) |

### Why this is our advantage, concretely

A `collect` node **cannot be talked out of collecting.** The required fields are a schema, the
question shown is framework-emitted, and the node does not advance until extraction succeeds.
A Pipecat node in the same position depends on the LLM choosing to call the right function on
every turn — which is the thing that fails under adversarial input, long context, or a weaker
model.

We saw this hold in live testing today: with a `collect` node, `gpt-4.1-mini` asked for the
missing unit id and would not proceed without it. Before the flow engaged on an earlier turn,
the same model invented a work-order id and a vendor id outright.

Their `respond_immediately` and our `'stay'` / their `NO_RESPONSE` sentinel are the same idea
under different names.

---

## 2. What they have that we do not

### 2.1 `pre_actions` / `post_actions` — the real gap

A declarative hook list per node, running before and after inference:

```python
pre_actions=[{"type": "tts_say", "text": "Let me check that for you…"}]
post_actions=[{"type": "notify_slack", "handler": notify}]
```

Built-ins for TTS plus arbitrary handlers, with `append_text_to_context` controlling whether
the spoken filler enters the transcript.

**We have nothing per-node.** Our nearest equivalent is `interim` / `interimAfterMs` on a
*tool*, which only covers "say something while this tool is slow" — not "always say this on
entering this node", and nothing at all for after.

This matters beyond voice. "Log to Slack when the escalation node is entered" is a per-node
side effect with no home in our model today; it has to be smuggled into an `action` node,
which then exists only to hold the hook.

### 2.2 `respond_immediately`

Explicit control over whether entering a node triggers inference at once, or waits for the
user. We infer this from node kind, which is less direct — and there is no way to say "enter
this `reply` node but stay silent until they speak."

---

## 3. Where we are ahead

- **Durable journal.** Their flows have no exactly-once effect log. Ours keys every effect,
  replays a finished step without re-executing, and survives a crash mid-node. For a flow
  that charges a card or dispatches a vendor this is the difference between a demo and
  production.
- **Typed transitions.** `Transition` is a union — `goto` / `handoff` / `escalate` / `end` /
  `'stay'` — checked at compile time. Theirs is a tuple returned from a handler.
- **`confirmGate`** as a first-class node, rather than a convention.
- **Per-node grounding** (`NodeGrounding`: query, knowledge overrides, memory scoping). No
  equivalent in theirs.

Context strategy is a draw: we both have `append` / `reset` / `reset_with_summary`.

---

## 4. Recommendation

**Add per-node lifecycle hooks.** This is the one place they are clearly ahead, and the gap
is real for non-voice use too. Suggested shape, matching our existing idiom:

```ts
reply({
  id: 'escalate',
  onEnter: async (state, ctx) => { await ctx.tool('notify_oncall', {...}); },
  onExit: async (state, ctx) => {...},
  …
})
```

Route it through `ctx.tool` so hooks inherit durability — theirs do not, and that would make
ours strictly better rather than a copy.

**Do not adopt their one-node model.** The four typed kinds are the reason our SOP holds when
the model would rather improvise, and that is the property worth defending.

## References
`src/pipecat/flows/types.py` (`NodeConfig`, `ContextStrategy`, `NO_RESPONSE`) ·
`src/pipecat/flows/manager.py` (`_set_node`, transition handling) ·
`src/pipecat/flows/actions.py` (the action registry) ·
`packages/core/src/types/flow.ts` · `docs/peer-patterns-stream-and-composition.md`
