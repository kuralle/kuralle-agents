# Flows (SOP Engine)

## Contents

- When to use flows
- Flow design rules
- Per-node `toolScope`
- Transition tools
- Example flow JSON
- Example tool transition

## When to use flows

Use flows when you have SOPs, compliance, validation, or step-by-step processes.

## Flow design rules

- One step = one question
- Do not hide required steps in prompts
- Always require identity before sensitive actions
- Put consequential tools on the node that owns them — do not leave them loose on the agent if a flow is meant to gate them

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

## Transition tools

Flow nodes can use tools that return transitions. This keeps the SOP deterministic.

## Example flow JSON

```json
{
  "nodes": [
    { "id": "collect_issue", "prompt": "Ask for issue summary" },
    { "id": "collect_identity", "prompt": "Collect account id + email" },
    { "id": "verify", "prompt": "Verify identity", "tool": "verify_identity" },
    { "id": "create_ticket", "prompt": "Create ticket", "tool": "create_ticket" },
    { "id": "done", "prompt": "Confirm ticket" }
  ],
  "edges": [
    { "from": "collect_issue", "to": "collect_identity" },
    { "from": "collect_identity", "to": "verify" },
    { "from": "verify", "to": "create_ticket" },
    { "from": "create_ticket", "to": "done" }
  ]
}
```

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
