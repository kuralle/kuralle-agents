# Flows (SOP Engine)

## Contents

- When to use flows
- Flow design rules
- Transition tools
- Example flow JSON
- Example tool transition

## When to use flows

Use flows when you have SOPs, compliance, validation, or step-by-step processes.

## Flow design rules

- One step = one question
- Do not hide required steps in prompts
- Always require identity before sensitive actions

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
