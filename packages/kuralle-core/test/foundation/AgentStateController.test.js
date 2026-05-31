import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DefaultAgentStateController } from '../../dist/foundation/DefaultAgentStateController.js';

function makeSession(overrides = {}) {
  const now = new Date();
  return {
    id: 'sess-1',
    messages: [],
    createdAt: now,
    updatedAt: now,
    workingMemory: {},
    currentAgent: 'agent-1',
    activeAgentId: undefined,
    state: {},
    metadata: { createdAt: now, lastActiveAt: now, totalTokens: 0, totalSteps: 0, handoffHistory: [] },
    agentStates: {},
    handoffHistory: [],
    ...overrides,
  };
}

describe('DefaultAgentStateController', () => {
  it('getActiveAgent returns activeAgentId when set', () => {
    const ctrl = new DefaultAgentStateController();
    const session = makeSession({ activeAgentId: 'agent-2' });

    assert.equal(ctrl.getActiveAgent(session, 'fallback'), 'agent-2');
  });

  it('getActiveAgent falls back to currentAgent', () => {
    const ctrl = new DefaultAgentStateController();
    const session = makeSession({ activeAgentId: undefined, currentAgent: 'agent-3' });

    assert.equal(ctrl.getActiveAgent(session, 'fallback'), 'agent-3');
  });

  it('getActiveAgent falls back to provided default', () => {
    const ctrl = new DefaultAgentStateController();
    const session = makeSession({ activeAgentId: undefined, currentAgent: undefined });

    assert.equal(ctrl.getActiveAgent(session, 'fallback'), 'fallback');
  });

  it('setActiveAgent updates both fields', () => {
    const ctrl = new DefaultAgentStateController();
    const session = makeSession();

    ctrl.setActiveAgent(session, 'new-agent');
    assert.equal(session.activeAgentId, 'new-agent');
    assert.equal(session.currentAgent, 'new-agent');
  });

  it('recordHandoff pushes to both handoffHistory and metadata', () => {
    const ctrl = new DefaultAgentStateController();
    const session = makeSession();

    ctrl.recordHandoff({
      session,
      fromAgentId: 'agent-1',
      toAgentId: 'agent-2',
      reason: 'user request',
    });

    assert.equal(session.handoffHistory.length, 1);
    assert.equal(session.handoffHistory[0].from, 'agent-1');
    assert.equal(session.handoffHistory[0].to, 'agent-2');
    assert.equal(session.handoffHistory[0].reason, 'user request');
    assert.ok(session.handoffHistory[0].timestamp instanceof Date);

    assert.equal(session.metadata.handoffHistory.length, 1);
    assert.equal(session.metadata.handoffHistory[0].from, 'agent-1');
  });

  it('updateAgentState creates new entry if not exists', () => {
    const ctrl = new DefaultAgentStateController();
    const session = makeSession();

    ctrl.updateAgentState(session, 'agent-1', { foo: 'bar' });

    assert.ok(session.agentStates['agent-1']);
    assert.equal(session.agentStates['agent-1'].agentId, 'agent-1');
    assert.deepEqual(session.agentStates['agent-1'].state, { foo: 'bar' });
  });

  it('updateAgentState merges into existing entry', () => {
    const ctrl = new DefaultAgentStateController();
    const session = makeSession();

    ctrl.updateAgentState(session, 'agent-1', { foo: 'bar' });
    ctrl.updateAgentState(session, 'agent-1', { baz: 'qux' });

    assert.deepEqual(session.agentStates['agent-1'].state, { foo: 'bar', baz: 'qux' });
  });

  it('isCircularHandoff detects circular visits', () => {
    const ctrl = new DefaultAgentStateController();

    assert.equal(ctrl.isCircularHandoff(['a', 'b', 'a'], 'a'), true);
    assert.equal(ctrl.isCircularHandoff(['a', 'b'], 'a'), false);
    assert.equal(ctrl.isCircularHandoff(['a', 'b', 'c'], 'a'), false);
  });

  it('isCircularHandoff respects custom maxVisits', () => {
    const ctrl = new DefaultAgentStateController();

    assert.equal(ctrl.isCircularHandoff(['a', 'b'], 'a', 1), true);
    assert.equal(ctrl.isCircularHandoff(['a', 'b'], 'a', 2), false);
  });
});
