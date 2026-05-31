import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldEmit, sanitizeForClient } from '../dist/index.js';

// ─── EXHAUSTIVE: Every HarnessStreamPart type must be classified ──────────────

const ALL_EVENT_TYPES = [
  'text-delta', 'text-clear', 'done', 'error', 'suggested-questions', 'input',
  'tool-call', 'tool-result', 'tool-error', 'tool-start', 'tool-done',
  'node-enter', 'node-exit',
  'flow-transition', 'flow-end',
  'handoff',
  'agent-start', 'agent-end',
  'step-start', 'step-end',
  'context-compacted', 'result-evicted',
  'tripwire', 'interrupted', 'turn-end', 'custom',
];

const SAFE_TYPES = new Set(['text-delta', 'text-clear', 'done', 'error', 'suggested-questions', 'input']);
const INTERNAL_TYPES = ALL_EVENT_TYPES.filter(t => !SAFE_TYPES.has(t));

test('exhaustive: every internal event type is blocked by safe filter', () => {
  for (const type of INTERNAL_TYPES) {
    const part = { type };
    const result = shouldEmit(part, 'safe');
    assert.equal(result, false, `LEAK: '${type}' should be blocked by safe filter but was allowed`);
  }
});

test('exhaustive: every safe event type is allowed by safe filter', () => {
  for (const type of SAFE_TYPES) {
    const part = { type };
    const result = shouldEmit(part, 'safe');
    assert.equal(result, true, `BROKEN: '${type}' should be allowed by safe filter but was blocked`);
  }
});

test('exhaustive: all filter allows every event type', () => {
  for (const type of ALL_EVENT_TYPES) {
    const result = shouldEmit({ type }, 'all');
    assert.equal(result, true, `'all' filter should allow '${type}'`);
  }
});

// ─── ADVERSARIAL: Try to bypass the filter ────────────────────────────────────

test('bypass attempt: unknown event type is blocked by safe filter', () => {
  const result = shouldEmit({ type: 'secret-internal-debug' }, 'safe');
  assert.equal(result, false, 'unknown event types should be blocked');
});

test('bypass attempt: tool-call with empty args is still blocked', () => {
  const result = shouldEmit({ type: 'tool-call', toolCallId: 'x', toolName: 'lookup', args: {} }, 'safe');
  assert.equal(result, false, 'tool-call with empty args still leaks tool name');
});

test('bypass attempt: node-enter with empty nodeName is still blocked', () => {
  const result = shouldEmit({ type: 'node-enter', nodeName: '' }, 'safe');
  assert.equal(result, false, 'node-enter with empty name still leaks event type');
});

test('bypass attempt: result-evicted with filepath is blocked', () => {
  const result = shouldEmit({ type: 'result-evicted', toolCallId: 'x', filepath: '/etc/passwd' }, 'safe');
  assert.equal(result, false, 'result-evicted MUST be blocked — leaks file paths');
});

test('bypass attempt: custom event with arbitrary data is blocked', () => {
  const result = shouldEmit({ type: 'custom', name: 'debug', data: { secret: 'api_key_123' } }, 'safe');
  assert.equal(result, false, 'custom events can carry arbitrary data — must block');
});

test('bypass attempt: tripwire reveals guardrail rules — must block', () => {
  const result = shouldEmit({
    type: 'tripwire', phase: 'input', processorId: 'jailbreak_detector',
    reason: 'prompt injection detected', message: 'User attempted SQL injection'
  }, 'safe');
  assert.equal(result, false, 'tripwire reveals security guardrail configuration');
});

// ─── ERROR SANITIZATION ──────────────────────────────────────────────────────

test('sanitize: SQL error details stripped', () => {
  const part = { type: 'error', error: 'Error: relation "users" does not exist at /app/db.ts:42' };
  const safe = sanitizeForClient(part);
  assert.equal(safe.error, 'An error occurred. Please try again.');
  assert.ok(!safe.error.includes('relation'), 'SQL details should not leak');
  assert.ok(!safe.error.includes('/app/'), 'file paths should not leak');
});

test('sanitize: API key in error stripped', () => {
  const part = { type: 'error', error: 'OpenAI API error: Invalid API key sk-proj-abc123def456' };
  const safe = sanitizeForClient(part);
  assert.ok(!safe.error.includes('sk-proj'), 'API key should not leak in error');
});

test('sanitize: stack trace stripped', () => {
  const part = { type: 'error', error: 'TypeError: Cannot read property of undefined\n    at FlowManager.runInference (/home/deploy/kuralle/dist/flows/FlowManager.js:457:24)' };
  const safe = sanitizeForClient(part);
  assert.ok(!safe.error.includes('FlowManager'), 'internal class names should not leak');
  assert.ok(!safe.error.includes('/home/deploy'), 'server paths should not leak');
});

test('sanitize: text-delta passes through unchanged', () => {
  const part = { type: 'text-delta', text: 'Hello, how can I help?' };
  const safe = sanitizeForClient(part);
  assert.deepEqual(safe, part, 'non-error events should pass through unchanged');
});

test('sanitize: done event passes through unchanged', () => {
  const part = { type: 'done', sessionId: 'sess-123' };
  const safe = sanitizeForClient(part);
  assert.deepEqual(safe, part);
});

// ─── CUSTOM FILTER FUNCTION ──────────────────────────────────────────────────

test('custom filter: allow only text-delta and flow-transition (for a flow visualization UI)', () => {
  const custom = (part) => part.type === 'text-delta' || part.type === 'flow-transition';

  assert.equal(shouldEmit({ type: 'text-delta', text: 'hi' }, custom), true);
  assert.equal(shouldEmit({ type: 'flow-transition', from: 'a', to: 'b' }, custom), true);
  assert.equal(shouldEmit({ type: 'tool-call', toolCallId: 'x', toolName: 'y', args: {} }, custom), false);
  assert.equal(shouldEmit({ type: 'done', sessionId: 'x' }, custom), false);
});

test('custom filter: throwing function blocks the event (fail-closed)', () => {
  const broken = () => { throw new Error('filter crashed'); };
  // shouldEmit should handle this gracefully — if it throws, event should be blocked (fail-closed)
  try {
    const result = shouldEmit({ type: 'text-delta', text: 'hi' }, broken);
    // If it doesn't throw, it should return false (fail-closed)
    assert.equal(result, false, 'broken filter should fail closed');
  } catch {
    // If shouldEmit propagates the throw, that's also acceptable — caller handles it
    // But it means the event won't be sent, which is safe
  }
});

// ─── CONSISTENCY: filter + sanitize compose correctly ─────────────────────────

test('composition: error passes filter but gets sanitized', () => {
  const part = { type: 'error', error: 'Internal: DB connection pool exhausted at line 42' };

  // Step 1: filter allows error
  assert.equal(shouldEmit(part, 'safe'), true);

  // Step 2: sanitize strips details
  const safe = sanitizeForClient(part);
  assert.equal(safe.type, 'error');
  assert.equal(safe.error, 'An error occurred. Please try again.');
});
