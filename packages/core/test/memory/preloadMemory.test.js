import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryMemoryService } from '../../dist/memory/stores/InMemoryMemoryService.js';
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
  it('should return formatted memory block when memories exist', async () => {
    const memoryService = new InMemoryMemoryService();

    const session = makeSession('s1', 'u1', [
      { role: 'user', content: 'My favorite color is blue' },
      { role: 'assistant', content: 'Got it, you love blue!' },
    ]);
    await memoryService.addSessionToMemory(session);

    const currentSession = makeSession('s2', 'u1', []);
    const result = await preloadMemoryContext(memoryService, currentSession, 'What is my favorite color?', 5000);

    assert.ok(result !== null);
    assert.ok(result.length > 0);
    assert.ok(result.includes('Context from Past Conversations'));
    assert.ok(result.includes('blue'));
  });

  it('should return null when no memories match', async () => {
    const memoryService = new InMemoryMemoryService();
    const session = makeSession('s1', 'u1', []);

    const result = await preloadMemoryContext(memoryService, session, 'anything', 5000);
    assert.equal(result, null);
  });

  it('should return null when session has no userId', async () => {
    const memoryService = new InMemoryMemoryService();
    const session = makeSession('s1', undefined, []);

    const result = await preloadMemoryContext(memoryService, session, 'test', 5000);
    assert.equal(result, null);
  });

  it('should respect maxTokens budget', async () => {
    const memoryService = new InMemoryMemoryService();

    const messages = [];
    for (let i = 0; i < 50; i++) {
      messages.push({ role: 'user', content: `Message about topic ${i} with some extra words to take up space and tokens` });
    }
    const session = makeSession('s1', 'u1', messages);
    await memoryService.addSessionToMemory(session);

    const currentSession = makeSession('s2', 'u1', []);
    const result = await preloadMemoryContext(memoryService, currentSession, 'topic', 100);

    // Should be truncated — not all 50 memories. Could be null if header alone exceeds budget.
    if (result !== null) {
      const tokenEstimate = Math.ceil(result.length / 4);
      assert.ok(tokenEstimate <= 150); // Some slack for heading
    }
  });

  it('should not include memories from a different user', async () => {
    const memoryService = new InMemoryMemoryService();

    const s1 = makeSession('s1', 'u1', [{ role: 'user', content: 'Secret for u1 only' }]);
    const s2 = makeSession('s2', 'u2', [{ role: 'user', content: 'Secret for u2 only' }]);

    await memoryService.addSessionToMemory(s1);
    await memoryService.addSessionToMemory(s2);

    const currentSession = makeSession('s3', 'u1', []);
    const result = await preloadMemoryContext(memoryService, currentSession, 'secret', 5000);

    assert.ok(result !== null);
    assert.ok(result.includes('u1'));
    assert.ok(!result.includes('u2'));
  });
});
