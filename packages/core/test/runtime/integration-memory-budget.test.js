import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryMemoryService } from '../../dist/memory/stores/InMemoryMemoryService.js';
import { preloadMemoryContext } from '../../dist/memory/preloadMemory.js';
import {
  DEFAULT_CONTEXT_BUDGET,
  computeMessageHistoryBudget,
  estimateTokenCount,
  truncateToTokenBudget,
  formatMemoryWithBudget,
} from '../../dist/runtime/ContextBudget.js';
import {
  handoffFilters,
  composeFilters,
} from '../../dist/runtime/handoffFilters.js';

describe('Integration: Memory + ContextBudget', () => {
  it('should preload memory within token budget from context budget system', async () => {
    const memoryService = new InMemoryMemoryService();

    const pastSession = {
      id: 'past-session',
      userId: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      messages: [
        { role: 'user', content: 'I prefer window seats on flights' },
        { role: 'assistant', content: 'Noted! I will remember your preference for window seats.' },
        { role: 'user', content: 'My frequent flyer number is FF12345' },
        { role: 'assistant', content: 'Got it, FF12345 saved.' },
      ],
      workingMemory: {},
      currentAgent: 'agent-1',
      agentStates: {},
      handoffHistory: [],
    };
    await memoryService.addSessionToMemory(pastSession);

    const budget = { ...DEFAULT_CONTEXT_BUDGET };
    const basePromptTokens = 500;
    const policyTokens = 100;
    const messageHistoryBudget = computeMessageHistoryBudget(budget, basePromptTokens, policyTokens);

    assert.ok(messageHistoryBudget > 0);
    assert.ok(messageHistoryBudget < budget.modelContextWindow);

    const currentSession = {
      id: 'current-session',
      userId: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      messages: [],
      workingMemory: {},
      currentAgent: 'agent-1',
      agentStates: {},
      handoffHistory: [],
    };

    const memoryBlock = await preloadMemoryContext(
      memoryService,
      currentSession,
      'What seat do I prefer on flights?',
      budget.maxLongTermMemoryTokens,
    );

    assert.ok(memoryBlock !== null);
    assert.ok(memoryBlock.includes('window seats'));
    const memoryTokens = estimateTokenCount(memoryBlock);
    assert.ok(memoryTokens <= budget.maxLongTermMemoryTokens + 100); // Allow heading overhead
  });

  it('should truncate content to fit token budget', () => {
    const longText = 'a'.repeat(10000); // ~2500 tokens
    const truncated = truncateToTokenBudget(longText, 500);
    const tokens = estimateTokenCount(truncated);
    // truncateToTokenBudget slices to maxTokens*4 chars + adds "[truncated]"
    // So tokens should be approximately maxTokens + small overhead
    assert.ok(tokens <= 510, `Expected <= 510 tokens but got ${tokens}`);
    assert.ok(tokens < 2500, 'Should be significantly shorter than original');
  });

  it('should format working memory within budget', () => {
    const memory = {
      key1: 'short value',
      key2: 'a'.repeat(5000), // ~1250 tokens
      key3: 'another value',
    };

    const formatted = formatMemoryWithBudget(memory, 500);
    const tokens = estimateTokenCount(formatted);
    assert.ok(tokens <= 600, `Expected <= 600 tokens but got ${tokens}`); // Overhead tolerance
  });

  it('should compute sensible message history budget with default config', () => {
    const budget = computeMessageHistoryBudget(DEFAULT_CONTEXT_BUDGET, 1000, 200);

    assert.ok(budget > 100000);
    assert.ok(budget < DEFAULT_CONTEXT_BUDGET.modelContextWindow);
  });

  it('should floor message history budget at 1000 tokens', () => {
    const tightBudget = {
      ...DEFAULT_CONTEXT_BUDGET,
      modelContextWindow: 5000,
      responseReserve: 2000,
      maxAutoRetrieveTokens: 500,
      maxWorkingMemoryTokens: 500,
      maxExtractionTokens: 500,
      maxLongTermMemoryTokens: 500,
    };

    const budget = computeMessageHistoryBudget(tightBudget, 2000, 500);
    assert.ok(budget >= 1000, `Expected >= 1000 but got ${budget}`);
  });
});

describe('Integration: Handoff Filters + Memory', () => {
  it('should compose filters and apply them to handoff data', async () => {
    const filter = composeFilters(
      handoffFilters.removeToolHistory,
      handoffFilters.keepRecentMessages(3),
      handoffFilters.removeKeys(['internalState']),
    );

    const data = {
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: [
          { type: 'text', text: 'Let me check' },
          { type: 'tool-call', toolCallId: 'tc1', toolName: 'search', args: {} },
        ]},
        { role: 'tool', content: [
          { type: 'tool-result', toolCallId: 'tc1', result: 'found it' },
        ]},
        { role: 'assistant', content: 'Here is the result' },
        { role: 'user', content: 'Thanks' },
        { role: 'assistant', content: 'You are welcome' },
      ],
      workingMemory: {
        userName: 'Alice',
        internalState: 'should-be-removed',
        preference: 'dark mode',
      },
      sourceAgentId: 'agent-a',
      targetAgentId: 'agent-b',
      reason: 'user requested transfer',
    };

    const result = await filter(data);

    // Tool history should be removed
    const hasToolRole = result.messages.some(m => m.role === 'tool');
    assert.equal(hasToolRole, false, 'Tool messages should be removed');

    // Should keep at most 3 recent messages
    assert.ok(result.messages.length <= 3, `Expected <= 3 messages, got ${result.messages.length}`);

    // internalState should be removed
    assert.equal(result.workingMemory.internalState, undefined);

    // Other keys should be preserved
    assert.equal(result.workingMemory.userName, 'Alice');
    assert.equal(result.workingMemory.preference, 'dark mode');
  });

  it('should handle empty messages gracefully', async () => {
    const filter = composeFilters(
      handoffFilters.removeToolHistory,
      handoffFilters.keepRecentMessages(5),
    );

    const result = await filter({
      messages: [],
      workingMemory: {},
      sourceAgentId: 'a',
      targetAgentId: 'b',
    });
    assert.equal(result.messages.length, 0);
  });
});

describe('Integration: Full Memory Pipeline', () => {
  it('should ingest, search, preload, and respect budget end-to-end', async () => {
    const memoryService = new InMemoryMemoryService();

    // Step 1: Ingest multiple sessions
    for (let i = 0; i < 3; i++) {
      const session = {
        id: `session-${i}`,
        userId: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
        messages: [
          { role: 'user', content: `In session ${i}, my order number was ORD-${i}00` },
          { role: 'assistant', content: `Got it, order ORD-${i}00 noted.` },
        ],
        workingMemory: {},
        currentAgent: 'agent-1',
        agentStates: {},
        handoffHistory: [],
      };
      await memoryService.addSessionToMemory(session);
    }

    // Step 2: Search for specific memory
    const searchResult = await memoryService.searchMemory({
      userId: 'user-1',
      query: 'order ORD-200',
      limit: 5,
    });
    assert.ok(searchResult.memories.length > 0);
    const topResult = searchResult.memories[0];
    assert.ok(topResult.content.includes('ORD-2'));

    // Step 3: Preload with budget
    const currentSession = {
      id: 'new-session',
      userId: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      messages: [],
      workingMemory: {},
      currentAgent: 'agent-1',
      agentStates: {},
      handoffHistory: [],
    };
    const memoryBlock = await preloadMemoryContext(
      memoryService,
      currentSession,
      'What was my order number?',
      2000,
    );

    assert.ok(memoryBlock !== null);
    assert.ok(memoryBlock.includes('ORD-'));
    assert.ok(memoryBlock.includes('Context from Past Conversations'));

    // Step 4: Verify budget compliance
    const tokens = estimateTokenCount(memoryBlock);
    assert.ok(tokens <= 2050);

    // Step 5: Delete memories and verify
    await memoryService.deleteMemories('user-1');
    const afterDelete = await memoryService.searchMemory({
      userId: 'user-1',
      query: 'order',
    });
    assert.equal(afterDelete.memories.length, 0);
  });

  it('should handle idempotent re-ingestion across the pipeline', async () => {
    const memoryService = new InMemoryMemoryService();

    const session = {
      id: 'session-1',
      userId: 'user-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      messages: [
        { role: 'user', content: 'My name is Alice' },
      ],
      workingMemory: {},
      currentAgent: 'agent-1',
      agentStates: {},
      handoffHistory: [],
    };

    await memoryService.addSessionToMemory(session);
    await memoryService.addSessionToMemory(session);

    const result = await memoryService.searchMemory({
      userId: 'user-1',
      query: 'Alice',
    });
    assert.equal(result.memories.length, 1);
  });
});
