import test from 'node:test';
import assert from 'node:assert/strict';

import { extractMemories } from '../dist/memory/utils.js';

const buildSession = (messages) => ({
  id: 'sess-1',
  userId: 'user-1',
  createdAt: new Date(),
  updatedAt: new Date(),
  messages,
  workingMemory: {},
  currentAgent: 'main',
  agentStates: {},
  handoffHistory: [],
});

test('extractMemories: skips non-user/assistant roles', () => {
  const session = buildSession([
    { role: 'system', content: 'hi' },
    { role: 'tool', content: 'result' },
    { role: 'user', content: 'hello' },
  ]);
  const memories = extractMemories(session);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].author, 'user');
});

test('extractMemories: flattens array text parts', () => {
  const session = buildSession([
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'first line' },
        { type: 'tool-call', toolName: 'foo' },
        { type: 'text', text: 'second line' },
      ],
    },
  ]);
  const memories = extractMemories(session);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].content, 'first line\nsecond line');
});

test('extractMemories: skips empty/whitespace content', () => {
  const session = buildSession([
    { role: 'user', content: '' },
    { role: 'assistant', content: '   ' },
    { role: 'user', content: 'kept' },
  ]);
  const memories = extractMemories(session);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].content, 'kept');
});

test('extractMemories: ids are deterministic sess:index', () => {
  const session = buildSession([
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' },
  ]);
  const memories = extractMemories(session);
  assert.deepEqual(
    memories.map(m => m.id),
    ['sess-1:0', 'sess-1:1', 'sess-1:2'],
  );
});

test('extractMemories: propagates options.metadata', () => {
  const session = buildSession([{ role: 'user', content: 'hi' }]);
  const memories = extractMemories(session, { metadata: { source: 'test' } });
  assert.deepEqual(memories[0].metadata, { source: 'test' });
});

test('extractMemories: each memory gets session id + userId', () => {
  const session = buildSession([{ role: 'user', content: 'hi' }]);
  const memories = extractMemories(session);
  assert.equal(memories[0].sessionId, 'sess-1');
  assert.equal(memories[0].userId, 'user-1');
});
