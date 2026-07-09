# Code-Based Agents (Examples)

Build agents, tools, and runtime directly in TypeScript — full type safety and control over wiring, hooks, and orchestration.

## When this fits

Use it when:
- You need custom runtime wiring or hooks
- You want tight control of tool routing
- You need dynamic agent creation
- You want custom orchestration logic
- You need full type safety
- You're building production applications

## Minimal code-first example

```ts
import { Runtime, type AgentConfig } from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';
import { tool } from 'ai';
import { z } from 'zod';

// 1. Define agent
const supportAgent: AgentConfig = {
  id: 'support',
  name: 'Support Agent',
  instructions: 'You are a helpful support agent.',
  model: openai('gpt-4o-mini') as any,
  tools: {
    echo: tool({
      description: 'Echo text',
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => ({ echoed: text }),
    }),
  },
};

// 2. Create runtime
const runtime = new Runtime({
  agents: [supportAgent],
  defaultAgentId: 'support',
});

// 3. Stream response
let sessionId: string | undefined;
for await (const part of runtime.stream({ input: 'Hello!', sessionId })) {
  if (part.type === 'text-delta') process.stdout.write(part.delta);
  if (part.type === 'done') sessionId = part.sessionId;
}
```

## Core code examples

Look at these for complete patterns:

- `standalone-chatbot` - Simple flow-based chatbot
- `customer-support-harness` - Multi-agent with triage
- `hybrid-flow-single` - Flow with detours
- `restaurant-reservation` - Reservation flow
- `insurance-quote` - Quote calculation flow
- `patient-intake` - Medical intake flow

## Fast grep

```bash
rg -n "new Runtime|flow agent|routing agent" packages/core/examples
```
