import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryMemoryService } from '../../dist/memory/stores/InMemoryMemoryService.js';

/** Helper: create a minimal session object */
function createSession(id, userId, messages = []) {
  return {
    id,
    userId,
    createdAt: new Date(),
    updatedAt: new Date(),
    messages,
    workingMemory: {},
    currentAgent: 'test-agent',
    agentStates: {},
    handoffHistory: [],
  };
}

test('InMemoryMemoryService: store and retrieve session memories', async () => {
  const service = new InMemoryMemoryService();
  const session = createSession('s1', 'user-1', [
    { role: 'user', content: 'I am allergic to peanuts' },
    { role: 'assistant', content: 'Noted, I will remember your peanut allergy.' },
  ]);

  await service.addSessionToMemory(session);

  const result = await service.searchMemory({ userId: 'user-1', query: 'peanuts allergy' });
  assert.ok(result.memories.length > 0, 'Should return at least one memory');
  assert.ok(
    result.memories.some((m) => m.content.includes('peanuts')),
    'Should contain peanut-related memory',
  );
});

test('InMemoryMemoryService: scope memories by userId', async () => {
  const service = new InMemoryMemoryService();

  await service.addSessionToMemory(
    createSession('s1', 'user-1', [{ role: 'user', content: 'I like cats' }]),
  );
  await service.addSessionToMemory(
    createSession('s2', 'user-2', [{ role: 'user', content: 'I like dogs' }]),
  );

  const user1Result = await service.searchMemory({ userId: 'user-1', query: 'cats dogs' });
  assert.ok(
    user1Result.memories.every((m) => m.userId === 'user-1'),
    'Should only return user-1 memories',
  );

  const user2Result = await service.searchMemory({ userId: 'user-2', query: 'cats dogs' });
  assert.ok(
    user2Result.memories.every((m) => m.userId === 'user-2'),
    'Should only return user-2 memories',
  );
});

test('InMemoryMemoryService: return empty for unknown userId', async () => {
  const service = new InMemoryMemoryService();
  const result = await service.searchMemory({ userId: 'nonexistent', query: 'anything' });
  assert.deepStrictEqual(result.memories, []);
});

test('InMemoryMemoryService: match keywords case-insensitively', async () => {
  const service = new InMemoryMemoryService();
  await service.addSessionToMemory(
    createSession('s1', 'user-1', [{ role: 'user', content: 'I prefer DARK mode' }]),
  );

  const result = await service.searchMemory({ userId: 'user-1', query: 'dark mode' });
  assert.ok(result.memories.length > 0, 'Should match case-insensitively');
});

test('InMemoryMemoryService: rank results by relevance score', async () => {
  const service = new InMemoryMemoryService();
  await service.addSessionToMemory(
    createSession('s1', 'user-1', [
      { role: 'user', content: 'I like red apples' },
      { role: 'user', content: 'red is my favorite color and I love red cars' },
    ]),
  );

  const result = await service.searchMemory({ userId: 'user-1', query: 'red color' });
  assert.ok(result.memories.length >= 2, 'Should return multiple matches');
  // The entry with more matching terms should rank higher
  assert.ok(
    (result.memories[0].score ?? 0) >= (result.memories[1].score ?? 0),
    'Higher scoring entry should come first',
  );
});

test('InMemoryMemoryService: respect limit parameter', async () => {
  const service = new InMemoryMemoryService();
  await service.addSessionToMemory(
    createSession('s1', 'user-1', [
      { role: 'user', content: 'fact one about topic' },
      { role: 'user', content: 'fact two about topic' },
      { role: 'user', content: 'fact three about topic' },
    ]),
  );

  const result = await service.searchMemory({ userId: 'user-1', query: 'topic', limit: 2 });
  assert.ok(result.memories.length <= 2, 'Should respect limit');
});

test('InMemoryMemoryService: handle sessions without userId gracefully', async () => {
  const service = new InMemoryMemoryService();
  const session = createSession('s1', undefined, [
    { role: 'user', content: 'some content' },
  ]);

  // Should not throw
  await service.addSessionToMemory(session);

  // Nothing should be stored
  const result = await service.searchMemory({ userId: 'undefined', query: 'content' });
  assert.deepStrictEqual(result.memories, []);
});

test('InMemoryMemoryService: handle multiple sessions for same user', async () => {
  const service = new InMemoryMemoryService();

  await service.addSessionToMemory(
    createSession('s1', 'user-1', [{ role: 'user', content: 'session one data' }]),
  );
  await service.addSessionToMemory(
    createSession('s2', 'user-1', [{ role: 'user', content: 'session two data' }]),
  );

  const result = await service.searchMemory({ userId: 'user-1', query: 'session data' });
  assert.ok(result.memories.length >= 2, 'Should return memories from both sessions');

  const sessionIds = new Set(result.memories.map((m) => m.sessionId));
  assert.ok(sessionIds.has('s1'), 'Should include session 1');
  assert.ok(sessionIds.has('s2'), 'Should include session 2');
});

test('InMemoryMemoryService: delete all memories for a user', async () => {
  const service = new InMemoryMemoryService();
  await service.addSessionToMemory(
    createSession('s1', 'user-1', [{ role: 'user', content: 'important fact' }]),
  );

  // Verify memories exist
  let result = await service.searchMemory({ userId: 'user-1', query: 'important' });
  assert.ok(result.memories.length > 0, 'Should have memories before delete');

  // Delete
  await service.deleteMemories('user-1');

  // Verify deletion
  result = await service.searchMemory({ userId: 'user-1', query: 'important' });
  assert.deepStrictEqual(result.memories, [], 'Should have no memories after delete');
});

test('InMemoryMemoryService: handle re-ingestion of same session (idempotency)', async () => {
  const service = new InMemoryMemoryService();
  const session = createSession('s1', 'user-1', [
    { role: 'user', content: 'original content about topic' },
  ]);

  await service.addSessionToMemory(session);
  const firstResult = await service.searchMemory({ userId: 'user-1', query: 'topic' });
  const firstCount = firstResult.memories.length;

  // Re-ingest the same session
  await service.addSessionToMemory(session);
  const secondResult = await service.searchMemory({ userId: 'user-1', query: 'topic' });

  assert.strictEqual(
    secondResult.memories.length,
    firstCount,
    'Should not duplicate memories on re-ingestion',
  );
});
