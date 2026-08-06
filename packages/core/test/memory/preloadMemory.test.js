import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryExtractedValueStore } from '../../dist/memory/extract/InMemoryExtractedValueStore.js';
import { preloadMemoryContext } from '../../dist/memory/preloadMemory.js';

function makeSession(id, userId, messages) {
  return {
    id,
    userId,
    createdAt: new Date(),
    updatedAt: new Date(),
    messages: messages.map(m => ({ role: m.role, content: m.content })),
    workingMemory: {},
    currentAgent: 'agent-1',
    agentStates: {},
    handoffHistory: [],
  };
}

describe('preloadMemoryContext', () => {
  it('should return formatted memory block when extracted facts exist', async () => {
    const store = new InMemoryExtractedValueStore();
    await store.save(
      {
        slug: 'facts',
        scope: 'user',
        value: { facts: ['My favorite color is blue'] },
        updatedAt: '2026-08-06T00:00:00.000Z',
      },
      'u1',
    );

    const currentSession = makeSession('s2', 'u1', []);
    const result = await preloadMemoryContext(store, currentSession, 'What is my favorite color?', 5000);

    assert.ok(result !== null);
    assert.ok(result.length > 0);
    assert.ok(result.includes('Context from Past Conversations'));
    assert.ok(result.includes('blue'));
  });

  it('should return null when no facts exist', async () => {
    const store = new InMemoryExtractedValueStore();
    const session = makeSession('s1', 'u1', []);

    const result = await preloadMemoryContext(store, session, 'anything', 5000);
    assert.equal(result, null);
  });

  it('should return null when session has no userId', async () => {
    const store = new InMemoryExtractedValueStore();
    const session = makeSession('s1', undefined, []);

    const result = await preloadMemoryContext(store, session, 'test', 5000);
    assert.equal(result, null);
  });

  it('should respect maxTokens budget', async () => {
    const store = new InMemoryExtractedValueStore();
    const facts = [];
    for (let i = 0; i < 50; i++) {
      facts.push(`Message about topic ${i} with some extra words to take up space and tokens`);
    }
    await store.save(
      {
        slug: 'facts',
        scope: 'user',
        value: { facts },
        updatedAt: '2026-08-06T00:00:00.000Z',
      },
      'u1',
    );

    const currentSession = makeSession('s2', 'u1', []);
    const result = await preloadMemoryContext(store, currentSession, 'topic', 100);

    // Should be truncated — not all 50 memories. Could be null if header alone exceeds budget.
    if (result !== null) {
      const tokenEstimate = Math.ceil(result.length / 4);
      assert.ok(tokenEstimate <= 150); // Some slack for heading
    }
  });

  it('should not include facts from a different user', async () => {
    const store = new InMemoryExtractedValueStore();
    await store.save(
      {
        slug: 'facts',
        scope: 'user',
        value: { facts: ['Secret for u1 only'] },
        updatedAt: '2026-08-06T00:00:00.000Z',
      },
      'u1',
    );
    await store.save(
      {
        slug: 'facts',
        scope: 'user',
        value: { facts: ['Secret for u2 only'] },
        updatedAt: '2026-08-06T00:00:00.000Z',
      },
      'u2',
    );

    const currentSession = makeSession('s3', 'u1', []);
    const result = await preloadMemoryContext(store, currentSession, 'secret', 5000);

    assert.ok(result !== null);
    assert.ok(result.includes('u1'));
    assert.ok(!result.includes('u2'));
  });
});
