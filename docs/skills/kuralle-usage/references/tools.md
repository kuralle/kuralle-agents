# Tools (Contracts + Schemas)

## Contents

- Tools vs Skills vs Flows
- Tool JSON schema
- Deterministic output
- Flow transitions
- Error handling

## Tools vs Skills vs Flows

Understanding the difference is critical:

| Aspect | Tools | Skills | Flows |
|--------|-------|--------|-------|
| **Purpose** | Execute actions | Provide knowledge | Orchestrate processes |
| **Returns** | Data from execution | Markdown content | State transitions |
| **Side effects** | DB/API calls | None | Session state changes |
| **Example** | `create_ticket()` creates ticket | "Return policy is 30 days..." | Collect → Verify → Process |

- **Tools**: Execute code and return data (e.g., create ticket, query database)
- **Skills**: Provide informational content for LLM reference (e.g., policies, guidelines)
- **Flows**: Multi-step structured workflows (e.g., return process with state)

See [Skills Guide](skills.md) for detailed skills documentation.

## Tool definition (use `parameters`, not `inputSchema`)

```ts
import { tool } from 'ai';
import { z } from 'zod';

const lookupOrder = tool({
  description: 'Lookup an order by id',
  parameters: z.object({ orderId: z.string() }),  // ← 'parameters', not 'inputSchema'
  execute: async ({ orderId }) => ({ orderId, status: 'shipped', etaDays: 2 }),
});
```

For config-pack `tool.json` files, the field name is `inputSchema` (config-pack format). In TypeScript code (Vercel AI SDK `tool()`), the field is `parameters`.

## Deterministic output

Tools return **data only**, never user-facing prose.

```ts
execute: async ({ orderId }) => ({ orderId, status: 'shipped', etaDays: 2 })
// ✓ structured data

execute: async ({ orderId }) => 'Your order is shipped!'
// ✗ prose — LLM should compose the response, not the tool
```

## Flow transitions

Flow tools return transitions, not data:

```ts
import { createFlowTransition } from '@kuralle-agents/core';

execute: async ({ summary }) => createFlowTransition('next_step', { summary })
```

## Dynamic tools per node (FlowContext access)

When tools need to read `collectedData`, use a function:

```ts
{
  id: 'my_node',
  tools: (ctx) => ({
    submit: tool({
      parameters: z.object({}),
      execute: async () => {
        const age = Number(ctx.collectedData.age);
        return createFlowTransition('next', { age });
      },
    }),
  }),
}
```

Static tools (`tools: { ... }`) are simpler when context access isn't needed.

## Error handling

Return structured errors instead of throwing:

```ts
execute: async ({ orderId }) => {
  const order = await db.getOrder(orderId);
  if (!order) return { error: 'not_found', orderId };
  return { orderId, status: order.status };
}
```

