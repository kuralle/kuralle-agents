import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RedisMemoryService } from '../dist/RedisMemoryService.js';

/**
 * Creates a mock RedisClientLike backed by an in-memory Map.
 * Supports get, set, del, sadd, srem, smembers, expire, mget.
 */
function createMockRedisClient() {
  const store = new Map();
  const sets = new Map();
  const expirations = new Map();

  return {
    _store: store,
    _sets: sets,
    _expirations: expirations,
    async get(key) { return store.get(key) ?? null; },
    async set(key, value) { store.set(key, value); return 'OK'; },
    async del(key) { store.delete(key); return 1; },
    async sadd(key, ...members) {
      if (!sets.has(key)) sets.set(key, new Set());
      for (const m of members) sets.get(key).add(m);
      return members.length;
    },
    async srem(key, ...members) {
      const s = sets.get(key);
      if (!s) return 0;
      let count = 0;
      for (const m of members) { if (s.delete(m)) count++; }
      return count;
    },
    async smembers(key) {
      const s = sets.get(key);
      return s ? [...s] : [];
    },
    async expire(key, seconds) {
      expirations.set(key, seconds);
      return 1;
    },
    async mget(...args) {
      const keys = Array.isArray(args[0]) ? args[0] : args;
      return keys.map(k => store.get(k) ?? null);
    },
  };
}

function makeSession(id, userId, messages) {
  return {
    id,
    userId,
    createdAt: new Date(),
    updatedAt: new Date(),
    messages,
    workingMemory: {},
    currentAgent: 'agent-1',
    agentStates: {},
    handoffHistory: [],
  };
}

describe('RedisMemoryService', () => {
  let client;
  let service;

  beforeEach(() => {
    client = createMockRedisClient();
    service = new RedisMemoryService({ client, prefix: 'test' });
  });

  it('should store memories from a session with userId', async () => {
    const session = makeSession('s1', 'u1', [
      { role: 'user', content: 'Hello there' },
      { role: 'assistant', content: 'Hi! How can I help?' },
    ]);

    await service.addSessionToMemory(session);

    // Should have 2 memory entries stored
    const ids = await client.smembers('test:user:u1:memories');
    assert.equal(ids.length, 2);
  });

  it('should skip ingestion when session has no userId', async () => {
    const session = makeSession('s1', undefined, [
      { role: 'user', content: 'Hello' },
    ]);

    await service.addSessionToMemory(session);

    const ids = await client.smembers('test:user:undefined:memories');
    assert.equal(ids.length, 0);
  });

  it('should scope memories by userId', async () => {
    const s1 = makeSession('s1', 'u1', [{ role: 'user', content: 'User1 message' }]);
    const s2 = makeSession('s2', 'u2', [{ role: 'user', content: 'User2 message' }]);

    await service.addSessionToMemory(s1);
    await service.addSessionToMemory(s2);

    const result1 = await service.searchMemory({ userId: 'u1', query: 'message' });
    const result2 = await service.searchMemory({ userId: 'u2', query: 'message' });

    assert.equal(result1.memories.length, 1);
    assert.ok(result1.memories[0].content.includes('User1'));
    assert.equal(result2.memories.length, 1);
    assert.ok(result2.memories[0].content.includes('User2'));
  });

  it('should handle idempotent re-ingestion (delete-then-insert)', async () => {
    const session = makeSession('s1', 'u1', [
      { role: 'user', content: 'Original message' },
    ]);

    await service.addSessionToMemory(session);

    // Re-ingest with different content
    const updated = makeSession('s1', 'u1', [
      { role: 'user', content: 'Updated message' },
    ]);
    await service.addSessionToMemory(updated);

    const result = await service.searchMemory({ userId: 'u1', query: 'message' });
    assert.equal(result.memories.length, 1);
    assert.ok(result.memories[0].content.includes('Updated'));
  });

  it('should search memories by keyword matching', async () => {
    const session = makeSession('s1', 'u1', [
      { role: 'user', content: 'I need help with my booking' },
      { role: 'assistant', content: 'I can help with your flight reservation' },
    ]);

    await service.addSessionToMemory(session);

    const result = await service.searchMemory({ userId: 'u1', query: 'booking help' });
    assert.ok(result.memories.length > 0);
  });

  it('should rank results by term overlap score', async () => {
    const session = makeSession('s1', 'u1', [
      { role: 'user', content: 'I like apples' },
      { role: 'assistant', content: 'I like apples and oranges and bananas' },
    ]);

    await service.addSessionToMemory(session);

    const result = await service.searchMemory({ userId: 'u1', query: 'apples oranges bananas' });
    assert.ok(result.memories.length === 2);
    // The one with more matches should rank higher
    assert.ok(result.memories[0].score >= result.memories[1].score);
    assert.ok(result.memories[0].content.includes('oranges'));
  });

  it('should respect limit parameter', async () => {
    const messages = [];
    for (let i = 0; i < 5; i++) {
      messages.push({ role: 'user', content: `Message about topic ${i}` });
    }
    const session = makeSession('s1', 'u1', messages);
    await service.addSessionToMemory(session);

    const result = await service.searchMemory({ userId: 'u1', query: 'topic', limit: 2 });
    assert.equal(result.memories.length, 2);
  });

  it('should return empty for unknown userId', async () => {
    const result = await service.searchMemory({ userId: 'unknown', query: 'anything' });
    assert.equal(result.memories.length, 0);
  });

  it('should delete all memories for a user', async () => {
    const session = makeSession('s1', 'u1', [
      { role: 'user', content: 'Remember this' },
      { role: 'assistant', content: 'I will remember' },
    ]);
    await service.addSessionToMemory(session);

    await service.deleteMemories('u1');

    const result = await service.searchMemory({ userId: 'u1', query: 'remember' });
    assert.equal(result.memories.length, 0);
  });

  it('should apply memoryTtlSeconds to stored memory keys', async () => {
    const ttlService = new RedisMemoryService({ client, prefix: 'test', memoryTtlSeconds: 3600 });
    const session = makeSession('s1', 'u1', [
      { role: 'user', content: 'Hello' },
    ]);

    await ttlService.addSessionToMemory(session);

    // Check that TTL was set on at least one memory key
    const hasExpiration = [...client._expirations.entries()].some(
      ([key, ttl]) => key.startsWith('test:memory:') && ttl === 3600
    );
    assert.ok(hasExpiration);
  });

  it('should extract only user and assistant messages (skip system, tool)', async () => {
    const session = makeSession('s1', 'u1', [
      { role: 'system', content: 'You are a helpful assistant' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'tool', content: 'Tool result data' },
    ]);

    await service.addSessionToMemory(session);

    const ids = await client.smembers('test:user:u1:memories');
    assert.equal(ids.length, 2); // Only user + assistant
  });

  it('should handle messages with array content parts (extract text only)', async () => {
    const session = makeSession('s1', 'u1', [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this image?' },
          { type: 'image', image: 'base64data...' },
        ],
      },
    ]);

    await service.addSessionToMemory(session);

    const result = await service.searchMemory({ userId: 'u1', query: 'image' });
    assert.equal(result.memories.length, 1);
    assert.equal(result.memories[0].content, 'What is in this image?');
  });
});
