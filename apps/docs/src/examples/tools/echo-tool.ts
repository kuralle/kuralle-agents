import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { defineAgent, defineTool, createRuntime } from '@kuralle-agents/core';

// Define a tool with a Zod input schema and an async execute function
const echo = defineTool({
  name: 'echo',
  description: 'Echo back the provided text',
  input: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ echoed: text }),
});

// Wire durable tools on the agent; flow nodes use buildToolSet for model-visible schema.
const agent = defineAgent({
  id: 'support',
  instructions: 'Use the echo tool when asked.',
  model: openai('gpt-4o-mini'),
  tools: { echo },
});

const runtime = createRuntime({ agents: [agent], defaultAgentId: 'support' });

const handle = runtime.run({ input: 'Echo "hello world"' });
for await (const part of handle.events) {
  if (part.type === 'text-delta') process.stdout.write(part.delta);
  if (part.type === 'done') console.log('\nDone.');
}
await handle;
