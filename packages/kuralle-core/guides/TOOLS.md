# Tools Guide

Kuralle tools use the Vercel AI SDK `tool(...)` API. Tools are how agents read data, write state, and trigger flow transitions.

## Tool Basics

```ts
import { tool } from 'ai';
import { z } from 'zod';

const lookup = tool({
  description: 'Lookup an account by email',
  inputSchema: z.object({ email: z.string().email() }),
  execute: async ({ email }) => ({ id: 'ACC-123', email }),
});
```

## Tool Helpers

Kuralle exposes:
- `createTool(...)`
- `createToolWithFiller(...)` for user-friendly filler text

```ts
import { createToolWithFiller } from '@kuralle-agents/core';

const lookup = createToolWithFiller({
  description: 'Lookup an account',
  filler: 'Let me check that...',
  inputSchema: z.object({ email: z.string().email() }),
  execute: async ({ email }) => ({ id: 'ACC-123', email }),
});
```

## Agent-to-Agent Consultation

Use specialist tools so a lead agent consults domain experts behind the scenes and synthesizes one unified response.

### Basic Example

```ts
import { generateText } from 'ai';
import { z } from 'zod';
import {
  buildToolSet,
  createRuntime,
  defineAgent,
  defineTool,
} from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';

const model = openai('gpt-4o-mini');

const consultWeather = defineTool({
  name: 'consult_weather',
  description: 'Ask the weather specialist a question',
  input: z.object({ question: z.string() }),
  execute: async ({ question }) => {
    const { text } = await generateText({
      model,
      system: 'Weather expert. Brief factual answers.',
      prompt: question,
    });
    return { agentId: 'weather', response: text };
  },
});

const lead = defineAgent({
  id: 'lead',
  instructions:
    'Research assistant. Use consult_weather for weather questions. Combine answers clearly.',
  model,
  tools: buildToolSet({ consult_weather: consultWeather }),
  effectTools: { consult_weather: consultWeather },
});

const runtime = createRuntime({
  agents: [lead],
  defaultAgentId: 'lead',
  defaultModel: model,
});

const handle = runtime.run({
  input: 'What is the weather in Paris?',
  sessionId: 'demo',
});
for await (const part of handle.events) {
  if (part.type === 'text-delta') process.stdout.write(part.text);
}
await handle;
```

### When to Use

- One lead agent consults specialists via tools and synthesizes a single answer
- Team collaboration without user-visible handoffs

### When NOT to Use

- Routing to a different agent persona — use `routes` + structured `routing` instead
- Simple API calls — use `defineTool` / `createTool` directly

See [standalone-agent.ts](../examples/agents/standalone-agent.ts) (Example 4) for a full working demo.
