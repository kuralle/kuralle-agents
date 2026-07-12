import { openai } from '@ai-sdk/openai';
import { createRuntime, defineAgent } from '@kuralle-agents/core';
import { RedisTraceStore } from '@kuralle-agents/redis-store';
import { createClient } from 'redis';

const client = createClient({ url: process.env.REDIS_URL });
await client.connect();

const agent = defineAgent({
  id: 'support',
  instructions: 'You are a helpful support agent.',
  model: openai('gpt-4o-mini'),
});

const runtime = createRuntime({
  agents: [agent],
  defaultAgentId: 'support',
  tracing: {
    store: new RedisTraceStore({ client, traceTtlSeconds: 7 * 24 * 60 * 60 }),
  },
});
