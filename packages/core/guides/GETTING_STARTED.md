# Getting Started with Kuralle Core

This guide shows a minimal runtime setup with a single agent.

## Prerequisites

- Node.js 18+
- `@ai-sdk/*` provider (example uses OpenAI)
- Environment variable: `OPENAI_API_KEY`

## Install

```bash
npm install @kuralle-agents/core ai zod @ai-sdk/openai
```

## Minimal Runtime

```ts
import 'dotenv/config';
import {
  createRuntime,
  defineAgent,
  createDateParser,
  createFileStreamSink,
} from '@kuralle-agents/core';
import { openai } from '@ai-sdk/openai';

const dateParser = createDateParser();
const model = openai('gpt-4o-mini');

const support = defineAgent({
  id: 'support',
  name: 'Support',
  instructions: 'You are a helpful support agent.',
  model,
  tools: { parse_date: dateParser },
});

const runtime = createRuntime({
  agents: [support],
  defaultAgentId: 'support',
  defaultModel: model,
  streamCallback: {
    sinks: [createFileStreamSink({ directory: './transcripts' })],
    eventMode: 'message',
    emitToolEvents: true,
    emitTextDeltas: false,
    emitFinalText: true,
  },
});

const handle = runtime.run({ input: 'Hello there', sessionId: 'demo' });
for await (const part of handle.events) {
  if (part.type === 'text-delta') process.stdout.write(part.delta);
}
await handle;
```

## Running

```bash
node index.ts
```

## Next Steps

- See **Runtime** for routing, sessions, and hooks: `guides/RUNTIME.md`
- See **Flows** for structured conversations: `guides/FLOWS.md`
- See **Guardrails** for safety and enforcement: `guides/GUARDRAILS.md`
