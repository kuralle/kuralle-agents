import test from 'node:test';
import assert from 'node:assert/strict';

import { reviveSession } from '../dist/session/utils.js';

const buildSerialized = () => ({
  id: 's1',
  userId: 'u1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  messages: [],
  workingMemory: {},
  currentAgent: 'main',
  handoffHistory: [
    { from: 'a', to: 'b', reason: 'x', timestamp: '2026-01-01T10:00:00.000Z' },
  ],
  metadata: {
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: '2026-01-02T00:00:00.000Z',
    totalTokens: 0,
    totalSteps: 0,
    handoffHistory: [
      { from: 'a', to: 'b', reason: 'x', timestamp: '2026-01-01T10:00:00.000Z' },
    ],
  },
  agentStates: {
    main: { agentId: 'main', state: { k: 'v' }, lastActive: '2026-01-02T00:00:00.000Z' },
  },
});

test('reviveSession: revives top-level createdAt/updatedAt as Date', () => {
  const s = reviveSession(buildSerialized());
  assert.ok(s.createdAt instanceof Date);
  assert.ok(s.updatedAt instanceof Date);
  assert.equal(s.createdAt.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(s.updatedAt.toISOString(), '2026-01-02T00:00:00.000Z');
});

test('reviveSession: revives handoffHistory timestamps', () => {
  const s = reviveSession(buildSerialized());
  assert.equal(s.handoffHistory.length, 1);
  assert.ok(s.handoffHistory[0].timestamp instanceof Date);
});

test('reviveSession: revives metadata dates (createdAt, lastActiveAt, nested handoff timestamps)', () => {
  const s = reviveSession(buildSerialized());
  assert.ok(s.metadata);
  assert.ok(s.metadata.createdAt instanceof Date);
  assert.ok(s.metadata.lastActiveAt instanceof Date);
  assert.ok(s.metadata.handoffHistory[0].timestamp instanceof Date);
});

test('reviveSession: revives agentStates[*].lastActive', () => {
  const s = reviveSession(buildSerialized());
  assert.ok(s.agentStates.main.lastActive instanceof Date);
  assert.deepEqual(s.agentStates.main.state, { k: 'v' });
});

test('reviveSession: accepts JSON string input', () => {
  const s = reviveSession(JSON.stringify(buildSerialized()));
  assert.ok(s.createdAt instanceof Date);
  assert.ok(s.agentStates.main.lastActive instanceof Date);
});

test('reviveSession: defaults missing handoffHistory + agentStates to empty', () => {
  const raw = buildSerialized();
  delete raw.handoffHistory;
  delete raw.agentStates;
  delete raw.metadata;
  const s = reviveSession(raw);
  assert.deepEqual(s.handoffHistory, []);
  assert.deepEqual(s.agentStates, {});
  assert.equal(s.metadata, undefined);
});
