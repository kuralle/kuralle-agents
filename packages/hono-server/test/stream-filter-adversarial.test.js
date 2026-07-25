import test from 'node:test';
import assert from 'node:assert/strict';
import { PART_CHANNEL } from '@kuralle-agents/core';
import { shouldEmit, sanitizeForClient } from '../dist/index.js';

const part = (type, payload = {}) => ({
  channel: PART_CHANNEL[type],
  type,
  payload,
});

test('unknown event types fail closed', () => {
  assert.equal(
    shouldEmit(
      { channel: 'internal', type: 'secret-internal-debug', payload: {} },
      'safe',
    ),
    false,
  );
});

test('internal payload contents cannot bypass classification', () => {
  assert.equal(
    shouldEmit(part('tool-call', { toolCallId: '', toolName: '', args: {} }), 'safe'),
    false,
  );
  assert.equal(
    shouldEmit(part('node-enter', { nodeName: '' }), 'safe'),
    false,
  );
  assert.equal(
    shouldEmit(part('custom', { name: 'debug', data: { secret: 'api_key_123' } }), 'safe'),
    false,
  );
});

test('sanitization strips SQL errors, API keys, and stack traces', () => {
  const messages = [
    'Error: relation "users" does not exist at /app/db.ts:42',
    'OpenAI API error: Invalid API key sk-proj-abc123def456',
    'TypeError\n    at FlowManager.runInference (/home/deploy/app.js:457:24)',
  ];
  const original = console.error;
  console.error = () => {};
  try {
    for (const message of messages) {
      const safe = sanitizeForClient(part('error', { error: message }));
      assert.equal(safe.type, 'error');
      assert.equal(safe.payload.error, 'An error occurred. Please try again.');
    }
  } finally {
    console.error = original;
  }
});

test('custom filter can intentionally expose selected internal types', () => {
  const filter = (streamPart) =>
    streamPart.type === 'text-delta' || streamPart.type === 'flow-transition';

  assert.equal(shouldEmit(part('text-delta'), filter), true);
  assert.equal(shouldEmit(part('flow-transition'), filter), true);
  assert.equal(shouldEmit(part('tool-call'), filter), false);
  assert.equal(shouldEmit(part('done'), filter), false);
});

test('a throwing custom filter never emits an event', () => {
  const broken = () => {
    throw new Error('filter crashed');
  };
  assert.throws(() => shouldEmit(part('text-delta'), broken), /filter crashed/);
});

test('safe error composition sanitizes after classification', () => {
  const streamPart = part('error', {
    error: 'Internal: DB connection pool exhausted at line 42',
  });
  assert.equal(shouldEmit(streamPart, 'safe'), true);

  const original = console.error;
  console.error = () => {};
  try {
    const safe = sanitizeForClient(streamPart);
    assert.equal(safe.payload.error, 'An error occurred. Please try again.');
  } finally {
    console.error = original;
  }
});
