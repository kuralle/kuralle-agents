# Flows

Model multi-step procedures as typed node graphs.

A flow is a small directed graph of typed nodes. Each node owns a slice of the conversation — collecting input, giving a reply, running an action, or making a decision — and returns a transition to the next node when it's done.

Put your SOP in a flow instead of a system prompt. Code you can test beats instructions you can't.

> **Note**
>
> Rule of thumb: if you're pasting more than ~20 lines of procedure into a system prompt, it belongs in a flow.

## Defining a flow

```typescript
import { defineFlow, reply, collect } from '@kuralle-agents/core';

const flow = defineFlow({
  name: 'booking',
  description: 'Book an appointment',
  start: getDate,          // the node to enter on the first turn
  nodes: [getDate, confirm], // every node in the flow
});
```

Attach the flow to an agent with `defineAgent({ flows: [flow] })`.

`defineFlow` validates what it can see statically and throws with the full issue list: an inline node object used as a transition target is rejected (`inline-transition-target`), as is a `start` missing from `nodes`.

The check stops at the edge of a function body. A `next` or `onComplete` that *returns* a node — `onComplete: () => confirm` — is opaque at definition time, so a target absent from `nodes` and a node nothing routes to both pass validation and fail later, at the transition. Register every node in `nodes` and prefer `{ goto: 'nodeId' }` over a returned reference when you want the id checked against the graph. The same validator backs the JSON dialect — see [Dynamic Flows](./dynamic-flows.md).

## Node kinds

### `reply`

Sends a response and returns a transition. Use it for confirmations, summaries, and any step where the agent speaks and then moves on.

```typescript
import { reply } from '@kuralle-agents/core';

const confirm = reply({
  id: 'confirm',
  instructions: 'Confirm the booking with the collected date, then end.',
  next: () => ({ end: 'done' }),
});
```

`next` is optional. When present it's called after the model responds (unless the turn produced a handoff or end control signal) and returns the next transition; omit it to stay on the node.

For transactional outcomes that must not be model-authored — "your order is placed", a refund confirmation — set `response: (state) => string` instead of letting the model speak. The engine emits that text verbatim, with no model call, and marks the turn `rendered: 'engine'` in the trace.

`instructions` stays required on the node even then. It is never used on a turn that `response` renders, so give it a one-line description of the node's job and do not spend effort on it.

### `collect`

Collects a structured schema from the user over one or more turns. The node re-enters until all `required` fields are filled. If `maxTurns` (default 10) is reached first, `onComplete` runs **only when the schema is genuinely satisfied**; otherwise the node escalates and names the fields it could not collect, rather than handing the rest of the flow a half-filled record.

```typescript
import { collect } from '@kuralle-agents/core';
import { z } from 'zod';

const getDate = collect({
  id: 'get_date',
  schema: z.object({ date: z.string() }),
  required: ['date'],
  ask: (missing) => `Which ${missing.join(' and ')} would you like?`,
  onComplete: () => confirm,
});
```

A collect node **never speaks model-authored text**. The extraction turn is non-speaking; the user-facing question is the deterministic `ask(missing, state)` — or, when `ask` is omitted, a safe default built from the missing field names. That is a structural backstop: the model cannot narrate a downstream outcome ("order placed", "payment taken") from inside a collect. The optional `instructions(missing, state)` is extraction-only guidance for the non-speaking turn and is never shown to the user. `onComplete` is called when all required fields are collected and returns the next node.

`resolvers` declares deterministic tier-0 resolution for individual fields (`enum_check`, `range`, `jsonpath`): a field resolved deterministically is excluded from the model's extraction schema that turn, so the model can never guess it.

`verbatimFields` names the fields the user must supply in their own words — an account id, an order number, a name. A model-extracted value for one of those is dropped when the user's turn does not contain it, so the model cannot invent an identifier nobody gave it. Guard only the fields that are quoted rather than normalised. Extraction is meant to rewrite what the user said — `next Friday` becomes an ISO date, `forty dollars` becomes `40`, a spoken complaint becomes a written summary — and a value picked from a list or button reply never appears in the turn text at all. Guarding those drops correct answers, and a dropped required field keeps the node re-asking until `maxTurns` runs out.

### `action`

Runs a side effect (tool call, API request, state update) without a user-facing reply. The node executes and then transitions immediately.

### `decide`

Asks the model for a structured decision against a `schema` (no user-facing reply), then `decide(data, state)` returns the next transition. Use it for routing branches that depend on classifying the conversation.

## Transitions

A node's `next` (or `onComplete`) function returns a `Transition`:

| Return value | Effect |
|---|---|
| A node object registered in `nodes` | Move to that node on the next turn |
| `{ goto: 'nodeId', data? }` | Move to the node with that id, merging `data` into flow state |
| `{ end: 'label' }` | End the flow with a label |
| `{ handoff: 'agentId', reason? }` | Hand off to another agent |
| `{ escalate: 'reason' }` | Escalate to a human |
| `'stay'` | Stay on the current node for another turn |

Targets are node objects from `nodes` or node ids — never inline node definitions or thunks. `defineFlow` rejects both at definition time, because an inline target has no stable identity for a parked run to resume against.

## Writing node instructions

A node's `instructions` is a focused micro-prompt for *that node's job* — not a system prompt. The flow already owns control flow (which node runs next); the instructions only steer what the model says and **which tool it calls** on this step. Two habits keep node prompts reliable.

**Map intent to a tool call explicitly.** A node usually advances when a specific tool fires — its `next` inspects `toolResults`. Don't assume the model will infer *when* to call it: name the trigger, list the phrases that should map to it, and require the call in the same turn.

```typescript
const confirm = reply({
  id: 'confirm',
  instructions: `Read back the order details. When the user clearly affirms the order is
correct — "yes", "looks good", "that's correct", "go ahead" — call complete_order
immediately in that same turn. Use revise_order only if they want to change something.
After any clear affirmative, you must call complete_order, not re-ask.`,
  tools: () => buildToolSet({ complete_order: completeOrder, revise_order: reviseOrder }),
  next: (turn) =>
    turn.toolResults.some((r) => r.name === 'complete_order') ? end : 'stay',
});
```

**Avoid confirmation loops.** Open-ended phrasing like *"ask if they want anything else or to make changes"* keeps the model asking — it never calls the tool, so the node never transitions. If a node should complete on agreement, tell it to *act* on agreement, not to *ask again*.

> **Tip**
>
> If a flow "won't finish," it's almost always the prompt, not the graph: the node's instructions are eliciting another question instead of the tool call that drives the transition. Make the completion tool the obvious, mandated response to a clear affirmative.

## Narrowing tools with `toolScope`

By default a reply node is **open**: the model sees the node's own tools plus `globalTools`, working-memory tools, and the agent's loose `tools`. That means `ReplyNode.tools` only ever *adds* — a consequential tool left on the agent stays callable even while a flow is trying to own it.

`toolScope` declares which layers the model may see on that node:

| scope | node tools | working-memory tools | `globalTools` | agent `tools` |
|---|---|---|---|---|
| `'open'` *(default)* | yes | yes | yes | yes |
| `'base'` | yes | yes | yes | no |
| `'closed'` | yes | no | no | no |

Flow-transition control tools (`handoff`, `escalate`, …) are governed separately by the out-of-band silo — independent of scope.

**`toolScope` vs `Policy`.** `toolScope` decides what the model **sees**. [`Policy`](./policy.md) decides whether a call that was made is **allowed to run**. Both apply; neither replaces the other. A denied call still costs a round-trip if the model could see the tool.

### Before / after

A spend-cap approval tool left on the agent can be called without entering the dispatch flow. Move it onto the node that owns it and declare `toolScope: 'base'` so agent tools are not re-unioned:

```typescript
import { reply, buildToolSet, defineAgent, defineFlow } from '@kuralle-agents/core';

// Before — tool is loose AND on the node; the model can bypass the flow.
defineAgent({
  tools: { notify_resident, dispatch_vendor_with_approval },
  flows: [dispatchFlow],
});

reply({
  id: 'confirm_dispatch',
  tools: buildToolSet({ dispatch_vendor_with_approval }),
  // resolved set still includes notify_resident + every other agent tool
});

// After — tool belongs only to this node.
defineAgent({
  tools: { notify_resident },
  globalTools: { lookup_unit },
  flows: [dispatchFlow],
});

reply({
  id: 'confirm_dispatch',
  toolScope: 'base',
  tools: buildToolSet({ dispatch_vendor_with_approval }),
  // resolved set: approval tool + globalTools + working-memory tools
});
```

`'open'` stays the default permanently — existing nodes are unchanged until you opt in. Use `'closed'` when the node should see exactly what you declared (collect extraction already does this internally). Use `'base'` when the lookups should stay available mid-flow but consequential agent tools should not.

Full worked sample:

`tool-scope.ts`:

```typescript
import { openai } from '@ai-sdk/openai';
import {
  defineAgent,
  defineFlow,
  defineTool,
  reply,
  buildToolSet,
} from '@kuralle-agents/core';
import { z } from 'zod';

const dispatch_vendor_with_approval = defineTool({
  name: 'dispatch_vendor_with_approval',
  description: 'Request owner approval before dispatching a vendor over the spend cap.',
  input: z.object({
    workOrderId: z.string(),
    vendorId: z.string(),
    estimateUsd: z.number(),
  }),
  needsApproval: true,
  execute: async (args) => ({ requested: true, ...args }),
});

const lookup_unit = defineTool({
  name: 'lookup_unit',
  description: 'Look up a unit.',
  input: z.object({ unitId: z.string() }),
  execute: async ({ unitId }) => ({ id: unitId }),
});

const notify_resident = defineTool({
  name: 'notify_resident',
  description: 'SMS the resident.',
  input: z.object({ unitId: z.string(), message: z.string() }),
  execute: async () => ({ sent: true }),
});

// Before toolScope: putting the approval tool on the node still left every agent
// tool visible, so the model could approve a dispatch without entering the flow.
const confirmDispatch = reply({
  id: 'confirm_dispatch',
  toolScope: 'base',
  tools: buildToolSet({ dispatch_vendor_with_approval }),
  instructions:
    'Call dispatch_vendor_with_approval with the pending work order, vendor, and estimate. ' +
    'Tell the manager you requested owner approval and stop.',
  next: (turn) =>
    turn.toolResults.some((r) => r.name === 'dispatch_vendor_with_approval')
      ? { end: 'approval_requested' }
      : 'stay',
});

const agent = defineAgent({
  id: 'property-manager',
  instructions: 'Property management assistant.',
  model: openai('gpt-4o-mini'),
  // Approval tool is NOT loose — only confirm_dispatch can see it.
  tools: { notify_resident },
  globalTools: { lookup_unit },
  flows: [
    defineFlow({
      name: 'dispatch_vendor_for_work_order',
      description: 'Send a vendor when the manager asks to dispatch.',
      start: confirmDispatch,
      nodes: [confirmDispatch],
    }),
  ],
});

void agent;
```

## Holding position across turns

A flow records its current node on the durable run and resumes there on the next turn. When a node returns `'stay'` (and there's no pending input), the run is persisted and the turn ends; the next `runtime.run({ input })` re-enters the *same* node rather than restarting the flow. A `collect` node uses this to gather one field at a time over several turns.

This means the flow keeps its place across turns automatically — you don't wire anything for it. For the full picture of how nodes are dispatched, how context is reshaped between them, and how a flow pauses and resumes, see the [Flow Execution Model](./flow-execution.md). To author the same graph as JSON, hot-register it on a live server, and version it behind Policy, see [Dynamic Flows](./dynamic-flows.md).

## Example: booking flow

`booking-flow.ts`:

```typescript
import { openai } from '@ai-sdk/openai';
import { defineAgent, defineFlow, collect, reply } from '@kuralle-agents/core';
import { z } from 'zod';

const confirm = reply({
  id: 'confirm',
  instructions: 'Confirm the booking with the collected date, then end.',
  next: () => ({ end: 'done' }),
});

const getDate = collect({
  id: 'get_date',
  schema: z.object({ date: z.string() }),
  required: ['date'],
  ask: (missing) => `Which ${missing.join(' and ')} would you like to book?`,
  onComplete: () => confirm,
});

const agent = defineAgent({
  id: 'booking',
  instructions: 'You are a booking agent.',
  model: openai('gpt-4o-mini'),
  flows: [
    defineFlow({
      name: 'booking',
      description: 'Book an appointment',
      start: getDate,
      nodes: [getDate, confirm],
    }),
  ],
});
```
