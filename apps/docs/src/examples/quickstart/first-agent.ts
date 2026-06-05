import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { defineAgent, defineTool, createRuntime, buildToolSet } from '@kuralle-agents/core';

const echo = defineTool({
  name: 'echo',
  description: 'Echo back the provided text',
  input: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ echoed: text }),
});

const agent = defineAgent({
  id: 'support',
  name: 'Support Agent',
  instructions: 'Helpful support agent. Use the echo tool when asked.',
  model: openai('gpt-4o-mini'),
  tools: buildToolSet({ echo }),   // make the tool model-visible
  effectTools: { echo },           // wire the durable executor
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'support',
});

let sessionId: string | undefined;

async function chat(input: string) {
  const handle = runtime.run({ input, sessionId });
  for await (const part of handle.events) {   // events is a property, not a method
    if (part.type === 'text-delta') process.stdout.write(part.delta);
    if (part.type === 'done') sessionId = part.sessionId;
  }
  await handle;
}

await chat('Use echo to say "hello"');
await chat('What did I just ask you to do?');
