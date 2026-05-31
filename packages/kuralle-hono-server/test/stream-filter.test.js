import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldEmit, sanitizeForClient } from '../dist/index.js';

/** @type {import('@kuralle-agents/core').HarnessStreamPart[]} */
const allHarnessPartSamples = [
  { type: 'input', text: 'hi' },
  { type: 'text-delta', text: 'x' },
  { type: 'text-clear', agentId: 'ag' },
  {
    type: 'tripwire',
    phase: 'input',
    processorId: 'p',
    reason: 'r',
  },
  {
    type: 'tool-call',
    toolCallId: 'c1',
    toolName: 't',
    args: { secret: true },
  },
  {
    type: 'tool-result',
    toolCallId: 'c1',
    toolName: 't',
    result: {},
  },
  {
    type: 'tool-error',
    toolCallId: 'c1',
    toolName: 't',
    error: 'e',
  },
  { type: 'handoff', from: 'a', to: 'b', reason: 'r' },
  { type: 'node-enter', nodeName: 'n' },
  { type: 'node-exit', nodeName: 'n' },
  { type: 'flow-transition', from: 'a', to: 'b' },
  { type: 'flow-end', reason: 'r' },
  { type: 'turn-end' },
  { type: 'step-start', step: 1, agentId: 'ag' },
  { type: 'step-end', step: 1, agentId: 'ag' },
  { type: 'agent-start', agentId: 'ag' },
  { type: 'agent-end', agentId: 'ag' },
  { type: 'context-compacted', messagesBefore: 10, messagesAfter: 2 },
  {
    type: 'result-evicted',
    toolCallId: 'c1',
    filepath: '/srv/secret.txt',
  },
  {
    type: 'interrupted',
    sessionId: 's',
    reason: 'r',
    timestamp: new Date(),
  },
  { type: 'custom', name: 'x', data: {} },
  { type: 'tool-start', toolCallId: 'c1', toolName: 't' },
  { type: 'tool-done', toolCallId: 'c1', toolName: 't', durationMs: 1 },
  { type: 'error', error: 'internal' },
  { type: 'suggested-questions', suggestions: ['a'], isPartial: false },
  { type: 'done', sessionId: 's' },
];

test('safe-filter-blocks-tool-call', () => {
  assert.equal(
    shouldEmit(
      { type: 'tool-call', toolCallId: '1', toolName: 'x', args: {} },
      'safe',
    ),
    false,
  );
});

test('safe-filter-blocks-node-enter', () => {
  assert.equal(shouldEmit({ type: 'node-enter', nodeName: 'n' }, 'safe'), false);
});

test('safe-filter-blocks-flow-transition', () => {
  assert.equal(
    shouldEmit({ type: 'flow-transition', from: 'a', to: 'b' }, 'safe'),
    false,
  );
});

test('safe-filter-blocks-result-evicted', () => {
  assert.equal(
    shouldEmit(
      { type: 'result-evicted', toolCallId: '1', filepath: '/x' },
      'safe',
    ),
    false,
  );
});

test('safe-filter-allows-text-delta', () => {
  assert.equal(shouldEmit({ type: 'text-delta', text: 'hi' }, 'safe'), true);
});

test('safe-filter-allows-done', () => {
  assert.equal(shouldEmit({ type: 'done', sessionId: 's' }, 'safe'), true);
});

test('safe-filter-allows-suggested-questions', () => {
  assert.equal(
    shouldEmit(
      { type: 'suggested-questions', suggestions: ['q'], isPartial: false },
      'safe',
    ),
    true,
  );
});

test('safe-filter-allows-input', () => {
  assert.equal(shouldEmit({ type: 'input', text: 'u' }, 'safe'), true);
});

test('safe-filter-allows-error-type-before-sanitize', () => {
  assert.equal(shouldEmit({ type: 'error', error: 'x' }, 'safe'), true);
});

test('all-filter-allows-everything', () => {
  for (const part of allHarnessPartSamples) {
    assert.equal(shouldEmit(part, 'all'), true, `type ${part.type}`);
  }
});

test('custom-filter-function', () => {
  const filter = (part) =>
    part.type === 'text-delta' || part.type === 'tool-call';
  assert.equal(shouldEmit({ type: 'text-delta', text: 'a' }, filter), true);
  assert.equal(
    shouldEmit(
      { type: 'tool-call', toolCallId: '1', toolName: 't', args: {} },
      filter,
    ),
    true,
  );
  assert.equal(shouldEmit({ type: 'node-enter', nodeName: 'n' }, filter), false);
});

test('sanitize-error-strips-details', () => {
  const logs = [];
  const orig = console.error;
  console.error = (...args) => {
    logs.push(args);
  };
  try {
    const out = sanitizeForClient({
      type: 'error',
      error: 'SQL syntax error at line 42',
    });
    assert.equal(out.type, 'error');
    assert.equal(out.error, 'An error occurred. Please try again.');
    assert.ok(logs.length >= 1);
  } finally {
    console.error = orig;
  }
});

test('sanitize-error-preserves-non-error', () => {
  const part = { type: 'text-delta', text: 'hi' };
  const out = sanitizeForClient(part);
  assert.deepEqual(out, part);
});
