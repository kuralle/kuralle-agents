import test from 'node:test';
import assert from 'node:assert/strict';
import { PART_CHANNEL } from '@kuralle-agents/core';
import { shouldEmit, sanitizeForClient } from '../dist/index.js';

const clientTypes = Object.entries(PART_CHANNEL)
  .filter(([, channel]) => channel === 'client')
  .map(([type]) => type);
const internalTypes = Object.entries(PART_CHANNEL)
  .filter(([, channel]) => channel === 'internal')
  .map(([type]) => type);

const part = (type) => ({
  channel: PART_CHANNEL[type],
  type,
  payload: {},
});

test('safe filter allows every client-channel type', () => {
  assert.deepEqual(clientTypes, [
    'text-start',
    'text-delta',
    'text-end',
    'text-cancel',
    'conversation-outcome',
    'error',
    'done',
  ]);
  for (const type of clientTypes) {
    assert.equal(shouldEmit(part(type), 'safe'), true, type);
  }
});

test('safe filter blocks every internal-channel type', () => {
  for (const type of internalTypes) {
    assert.equal(shouldEmit(part(type), 'safe'), false, type);
  }
});

test('all filter allows every classified type', () => {
  for (const type of Object.keys(PART_CHANNEL)) {
    assert.equal(shouldEmit(part(type), 'all'), true, type);
  }
});

test('custom filter receives the typed envelope', () => {
  const filter = (streamPart) =>
    streamPart.type === 'text-delta' || streamPart.type === 'tool-call';
  assert.equal(shouldEmit(part('text-delta'), filter), true);
  assert.equal(shouldEmit(part('tool-call'), filter), true);
  assert.equal(shouldEmit(part('node-enter'), filter), false);
});

test('sanitize error strips details without changing the envelope', () => {
  const logs = [];
  const original = console.error;
  console.error = (...args) => {
    logs.push(args);
  };
  try {
    const output = sanitizeForClient({
      channel: 'client',
      type: 'error',
      payload: { error: 'SQL syntax error at line 42' },
    });
    assert.deepEqual(output, {
      channel: 'client',
      type: 'error',
      payload: { error: 'An error occurred. Please try again.' },
    });
    assert.ok(logs.length >= 1);
  } finally {
    console.error = original;
  }
});

test('sanitize preserves non-error parts', () => {
  const streamPart = {
    channel: 'client',
    type: 'text-delta',
    payload: { id: 't', delta: 'hi' },
  };
  assert.deepEqual(sanitizeForClient(streamPart), streamPart);
});
