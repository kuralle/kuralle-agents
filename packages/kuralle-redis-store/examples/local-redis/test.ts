import { config as loadEnv } from 'dotenv';
import { createClient } from 'redis';
import { RedisSessionStore, type RedisClientLike } from '../../src/index.js';
import type { Session } from '@kuralle-agents/core';

loadEnv();

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
const prefix = 'kuralle-demo';

const client = createClient({ url: redisUrl });
client.on('error', (err) => {
  console.error('Redis client error:', err);
});

const run = async () => {
  await client.connect();

  const store = new RedisSessionStore({
    client: client as unknown as RedisClientLike, // redis client command overloads don't match the minimal interface
    prefix,
    sessionTtlSeconds: 300,
  });

  const now = new Date();
  const session: Session = {
    id: `session-${Date.now()}`,
    conversationId: `conv-${Date.now()}`,
    channelId: 'api',
    userId: 'user-123',
    createdAt: now,
    updatedAt: now,
    messages: [
      { role: 'user', content: 'Hello from Redis store example.' },
      { role: 'assistant', content: 'Hi! I can help with that.' },
    ],
    workingMemory: { locale: 'en-US' },
    currentAgent: 'support',
    activeAgentId: 'support',
    state: { topic: 'demo' },
    metadata: {
      createdAt: now,
      lastActiveAt: now,
      totalTokens: 0,
      totalSteps: 0,
      handoffHistory: [],
    },
    agentStates: {},
    handoffHistory: [],
  };

  await store.save(session);

  const fetched = await store.get(session.id);
  const userSessions = await store.list('user-123');
  const raw = await client.get(`${prefix}:session:${session.id}`);

  console.log('Saved session id:', session.id);
  console.log('Fetched messages:', fetched?.messages.length ?? 0);
  console.log('User session count:', userSessions.length);
  console.log('Raw Redis JSON exists:', Boolean(raw));

  await client.disconnect();
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
