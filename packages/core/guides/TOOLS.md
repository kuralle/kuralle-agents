# Tools Guide

Kuralle tools use the Vercel AI SDK `tool(...)` API. Tools are how agents read data, write state, and trigger flow transitions.

## Durable agent tools

Agent-level `tools` is a `Record<string, AnyTool>` from `defineTool` — every call is journaled (exactly-once on replay). Flow nodes use `buildToolSet({ ... })` for model-visible schema; executors come from the agent registry and flow-local tools.

For third-party AI SDK tools, use `wrapAiSdkTool(name, aiTool)` — it captures `execute` and routes through the same journal:

```ts
import { defineTool, wrapAiSdkTool } from '@kuralle-agents/core';
import { tool } from 'ai';

const native = defineTool({ name: 'lookup', description: '...', input: z.object({ id: z.string() }), execute: async ({ id }) => ({ id }) });

const sdk = tool({ description: 'Legacy SDK tool', inputSchema: z.object({ id: z.string() }), execute: async ({ id }) => ({ id }) });

const agent = defineAgent({
  id: 'a',
  model,
  tools: { lookup: native, legacy: wrapAiSdkTool('legacy', sdk) },
});
```

## Agent workspace

Set `workspace` to a portable `FileSystem` (from `@kuralle-agents/fs`) to auto-register the durable `workspace` tool (`ls`, `cat`, `grep`, `find`, `read`, `write`, `edit`). The same instance is exposed on `RunContext.fs` for flow `action` nodes.

**Read-only by default** (ADR 0006): a bare `FileSystem` is mounted read-only and exposed in `globalTools` (safe for every speaking turn). Pass `{ fs, readOnly: false }` for a writable scratchpad — the executor is registered, but the tool is **not** auto-added to `globalTools` (mutating tools stay flow-gated).

```ts
import { InMemoryFs } from '@kuralle-agents/fs';

const agent = defineAgent({
  id: 'kb',
  model,
  workspace: new InMemoryFs({ '/docs/faq.md': '# FAQ' }),
});

// Writable scratchpad (not in globalTools):
// workspace: { fs: new InMemoryFs({ '/scratch': '' }), readOnly: false },
```

Requires `@kuralle-agents/fs` when using `workspace`.

## Working memory blocks

Cross-session markdown blocks (`USER`, `MEMORY`, …) via `agent.memory.workingMemory`. Blocks load at session start, inject into the system prompt, and are editable with the auto-registered `memory_block` tool.

```ts
import { defineAgent, FilePersistentMemoryStore } from '@kuralle-agents/core';

const agent = defineAgent({
  id: 'support',
  model,
  memory: {
    workingMemory: {
      store: new FilePersistentMemoryStore(),
      autoLoad: [
        { scope: 'user', key: 'USER', template: 'name:\npreferences:' },
        { scope: 'agent', key: 'MEMORY' },
      ],
    },
  },
});
```

On Workers, pass an explicit `store` (or `HarnessConfig.defaultWorkingMemoryStore`). Semantic recall (`preload` / `ingest`) is unchanged — working memory is an additional axis.

See [examples/agents/working-memory.ts](../examples/agents/working-memory.ts) for a live cross-session demo.

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
  tools: { consult_weather: consultWeather },
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
  if (part.type === 'text-delta') process.stdout.write(part.delta);
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
