# Flows (SOP Engine)

## Contents

- When to use flows
- Flow design rules
- `defineFlow` validates at definition time
- Per-node `toolScope`
- Template replies
- Collect resolvers
- Gates
- Transition tools
- Example flow definition (JSON dialect)
- Example tool transition

## When to use flows

Use flows when you have SOPs, compliance, validation, or step-by-step processes. Flows come in two dialects: code-first (`defineFlow` + `reply`/`collect`/`action`/`decide`, this file) and the JSON `FlowDefinition` dialect for stored/dynamic flows (`references/flow-definitions.md`).

## Flow design rules

- One step = one question
- Do not hide required steps in prompts
- Always require identity before sensitive actions
- Put consequential tools on the node that owns them — do not leave them loose on the agent if a flow is meant to gate them

## `defineFlow` validates at definition time

`defineFlow` throws on structural issues: duplicate node ids, a `start` outside `nodes`, unresolvable `goto` targets, and nodes unreachable from `start`.

Transition targets must be **registered** nodes. A `Transition` is a node object that is a member of `flow.nodes` (the same object reference), `{ goto: '<id>' }`, `{ handoff }`, `{ escalate }`, `{ end }`, or `'stay'`:

- **Inline node objects are rejected.** A transition target that is not the object registered in `flow.nodes` fails — statically (`inline-transition-target`) for declared transitions like `confirmGate.*` and `confidenceGate.onLow`, and at run time for transitions returned from handlers (`next`, `onComplete`, `decide`, `run`). Register the node and reference that object or its id.
- **Transition thunks are rejected.** A function *as the transition value* (e.g. `confirmGate.onConfirm: () => node` or `{ goto: () => node }`) is not allowed. Handler functions (`next: (turn, state) => Transition`) are fine — the thunk rule is about the returned/declared transition itself.

Any older snippet that builds a node inline inside a transition is wrong under this rule — register every node, reference by object or id.

## Per-node `toolScope`

`ReplyNode.toolScope` declares which tool layers the model may see on that node. Default is `'open'` (today's union) and stays the default permanently.

| scope | node tools | working-memory | `globalTools` | agent `tools` |
|---|---|---|---|---|
| `'open'` *(default)* | yes | yes | yes | yes |
| `'base'` | yes | yes | yes | no |
| `'closed'` | yes | no | no | no |

```ts
import { reply, buildToolSet } from '@kuralle-agents/core';

reply({
  id: 'confirm_dispatch',
  toolScope: 'base',
  tools: buildToolSet({ dispatch_vendor_with_approval }),
  instructions: 'Call dispatch_vendor_with_approval, then stop.',
});
```

**`toolScope` vs `Policy`:** `toolScope` decides what the model **sees**; `Policy` decides whether a call may **run**. Both apply. Use `toolScope` so a tool is unavailable loosely and available only on the owning node; use `Policy` / `needsApproval` for authorization of calls that were made.

## Template replies

A reply node can emit framework-authored text instead of model-authored text. Use this for transactional outcomes that must not be paraphrased:

```ts
reply({
  id: 'refunded',
  instructions: 'unused for the emitted text',
  response: (state) => `Refund issued for order ${state.orderId}.`,
  next: () => ({ end: 'refunded' }),
});
```

In the JSON dialect the same node is `{ kind: 'reply', id, response: { template: 'Refund issued for order ${state.orderId}.' } }` — rendered by the template engine, never by the model.

## Collect resolvers

`collect.resolvers` resolve fields deterministically before the model sees them (tier-0). A field resolved here is excluded from the model schema for that turn:

```ts
collect({
  id: 'gather',
  schema,
  required: ['size', 'qty'],
  resolvers: [
    { field: 'size', kind: 'enum_check', values: ['small', 'medium', 'large'] },
    { field: 'qty', kind: 'range', min: 1, max: 20 },
  ],
  onComplete: (data) => ({ goto: 'confirm', data: data as Record<string, unknown> }),
});
```

Kinds: `enum_check` (exact match against `values`), `range` (numeric bounds), `jsonpath` (extract by path). Model-extracted values also pass a provenance guard — a value the source turn does not contain is dropped, not merged. See `references/extraction-nodes.md`.

## Gates

`Flow.gates` (and `FlowDefinition.gates`) run when the flow reaches a terminal transition — predicate checks or a judge over an explicit allow-list of run-record paths. `severity` is `'blocking'` or `'advisory'`; a gate that fails to *execute* always blocks; a blocking failure ends the run with outcome `failed-verification`. Details in `references/flow-definitions.md`.

## Transition tools

Flow nodes can use tools that return transitions. This keeps the SOP deterministic.

## Example flow definition (JSON dialect)

The stored/dynamic dialect is `FlowDefinition` — typed nodes, transitions by id, no prose `edges` list:

```json
{
  "name": "support_ticket",
  "description": "Verify identity, then create a ticket",
  "start": "collect_identity",
  "nodes": [
    {
      "kind": "collect",
      "id": "collect_identity",
      "schema": {
        "type": "object",
        "properties": { "accountId": { "type": "string" }, "email": { "type": "string" } },
        "required": ["accountId", "email"]
      },
      "required": ["accountId", "email"],
      "next": { "goto": "verify" }
    },
    {
      "kind": "action",
      "id": "verify",
      "tool": "verify_identity",
      "args": {
        "accountId": { "path": "state.accountId" },
        "email": { "path": "state.email" }
      },
      "routes": [
        {
          "when": { "op": "truthy", "value": { "path": "results.verify.ok" } },
          "to": { "goto": "create_ticket" }
        }
      ],
      "next": { "goto": "collect_identity" }
    },
    { "kind": "action", "id": "create_ticket", "tool": "create_ticket", "next": { "goto": "done" } },
    {
      "kind": "reply",
      "id": "done",
      "response": { "template": "Ticket created for account ${state.accountId}." },
      "next": { "end": "ticket-created" }
    }
  ]
}
```

Validate with `validateFlowDefinition`, register with `runtime.addDynamicFlows` — full dialect reference in `references/flow-definitions.md`.

## Example tool transition

```ts
import { createFlowTransition } from '@kuralle-agents/core';

const verifyIdentity = async ({ accountId, email }) => {
  const ok = await verify(accountId, email);
  return ok
    ? createFlowTransition('create_ticket', { accountId })
    : createFlowTransition('collect_identity', { reason: 'mismatch' });
};
```
