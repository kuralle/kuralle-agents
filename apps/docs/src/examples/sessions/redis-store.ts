import { createRuntime, defineAgent } from '@kuralle-agents/core';
import { RedisSessionStore } from '@kuralle-agents/redis-store';
import { createClient } from 'redis';
import { openai } from '@ai-sdk/openai';

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
  sessionStore: new RedisSessionStore({ client }),
});
