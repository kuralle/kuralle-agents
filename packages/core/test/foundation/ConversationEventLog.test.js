import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultConversationEventLog } from '../../dist/foundation/DefaultConversationEventLog.js';
import { MemoryStore } from '../../dist/session/stores/MemoryStore.js';

function makeSession(id = 'sess-1') {
  const now = new Date();
  return {
    id,
    messages: [],
    createdAt: now,
    updatedAt: now,
    workingMemory: {},
    currentAgent: 'agent-1',
    activeAgentId: 'agent-1',
    state: {},
    metadata: { createdAt: now, lastActiveAt: now, totalTokens: 0, totalSteps: 0, handoffHistory: [] },
    agentStates: {},
    handoffHistory: [],
  };
}

function makeContext(session) {
  return {
    session,
    agentId: 'agent-1',
    stepCount: 0,
    totalTokens: 0,
    handoffStack: [],
    startTime: Date.now(),
    consecutiveErrors: 0,
    toolCallHistory: [],
  };
}

describe('DefaultConversationEventLog', () => {
  function createLog() {
    return new DefaultConversationEventLog({ sessionStore: new MemoryStore() });
  }

  it('records user input event', () => {
    const log = createLog();
    const session = makeSession();
    const ctx = makeContext(session);

    log.record(ctx, { type: 'input', text: 'hello', userId: 'user-1' });

    const events = session.workingMemory['runtimeEventLog'];
    assert.ok(Array.isArray(events));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'user');
    assert.equal(events[0].text, 'hello');
  });

  it('accumulates text-delta into assistant text', () => {
    const log = createLog();
    const session = makeSession();
    const ctx = makeContext(session);

    log.record(ctx, { type: 'text-delta', id: 't1', delta: 'hello ' });
    log.record(ctx, { type: 'text-delta', id: 't1', delta: 'world' });

    assert.equal(session.workingMemory['__ariaAssistantText'], 'hello world');
    // No event log entry yet (text-delta is accumulated)
    assert.equal(session.workingMemory['runtimeEventLog'], undefined);
  });

  it('flushes assistant text on turn-end', () => {
    const log = createLog();
    const session = makeSession();
    const ctx = makeContext(session);

    log.record(ctx, { type: 'text-delta', id: 't1', delta: 'hello world' });
    log.record(ctx, { type: 'turn-end' });

    const events = session.workingMemory['runtimeEventLog'];
    assert.ok(Array.isArray(events));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'assistant_final');
    assert.equal(events[0].text, 'hello world');
    // Assistant text should be cleaned up
    assert.equal(session.workingMemory['__ariaAssistantText'], undefined);
  });

  it('records tool-call event with truncated args', () => {
    const log = createLog();
    const session = makeSession();
    const ctx = makeContext(session);

    log.record(ctx, { type: 'tool-call', toolCallId: 'tc-1', toolName: 'search', args: { query: 'test' } });

    const events = session.workingMemory['runtimeEventLog'];
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'tool_call');
    assert.equal(events[0].toolName, 'search');
    assert.deepEqual(events[0].args, { query: 'test' });
  });

  it('records tool-result event', () => {
    const log = createLog();
    const session = makeSession();
    const ctx = makeContext(session);

    log.record(ctx, { type: 'tool-result', toolCallId: 'tc-1', toolName: 'search', result: { items: [1, 2] } });

    const events = session.workingMemory['runtimeEventLog'];
    assert.equal(events[0].type, 'tool_result');
    assert.deepEqual(events[0].result, { items: [1, 2] });
  });

  it('records tool-error event', () => {
    const log = createLog();
    const session = makeSession();
    const ctx = makeContext(session);

    log.record(ctx, { type: 'tool-error', toolCallId: 'tc-1', toolName: 'search', error: 'not found' });

    const events = session.workingMemory['runtimeEventLog'];
    assert.equal(events[0].type, 'tool_error');
    assert.equal(events[0].error, 'not found');
  });

  it('records handoff event', () => {
    const log = createLog();
    const session = makeSession();
    const ctx = makeContext(session);

    log.record(ctx, { type: 'handoff', from: 'agent-1', to: 'agent-2', reason: 'routing' });

    const events = session.workingMemory['runtimeEventLog'];
    assert.equal(events[0].type, 'transition');
    assert.equal(events[0].kind, 'handoff');
  });

  it('respects max entry limit', () => {
    const log = createLog();
    const session = makeSession();
    const ctx = makeContext(session);

    // Add 2001 events
    for (let i = 0; i < 2001; i++) {
      log.record(ctx, { type: 'input', text: `msg-${i}` });
    }

    const events = session.workingMemory['runtimeEventLog'];
    assert.equal(events.length, 2000);
    // First event should be msg-1 (msg-0 was evicted)
    assert.equal(events[0].text, 'msg-1');
  });

  it('shouldCheckpoint returns true for tool-result', () => {
    const log = createLog();
    assert.equal(log.shouldCheckpoint({ type: 'tool-result', toolCallId: 'tc', toolName: 't', result: {} }), true);
  });

  it('shouldCheckpoint returns false for text-delta', () => {
    const log = createLog();
    assert.equal(log.shouldCheckpoint({ type: 'text-delta', id: 't', delta: 'hi' }), false);
  });

  it('cleanup removes assistant text key', () => {
    const log = createLog();
    const session = makeSession();
    session.workingMemory['__ariaAssistantText'] = 'leftover';

    log.cleanup(session);
    assert.equal(session.workingMemory['__ariaAssistantText'], undefined);
  });

  it('checkpoint saves session to store', async () => {
    const store = new MemoryStore();
    const log = new DefaultConversationEventLog({ sessionStore: store });
    const session = makeSession('checkpoint-test');

    await log.checkpoint(session);

    const saved = await store.get('checkpoint-test');
    assert.ok(saved);
    assert.equal(saved.id, 'checkpoint-test');
  });
});
