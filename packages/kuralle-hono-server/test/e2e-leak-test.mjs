#!/usr/bin/env node
/**
 * E2E leak test: sends a message to the SSE endpoint and captures
 * ALL events that reach the client. Asserts no internal events leak.
 */

const SERVER = process.env.SERVER_URL || 'http://127.0.0.1:3333';

async function captureSSEEvents(message) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  const res = await fetch(`${SERVER}/api/chat/sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
    signal: controller.signal,
  });

  const events = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            events.push(data);
          } catch {}
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') throw err;
  }

  clearTimeout(timeout);
  return events;
}

const INTERNAL_TYPES = new Set([
  'tool-call', 'tool-result', 'tool-error', 'tool-start', 'tool-done',
  'node-enter', 'node-exit',
  'flow-transition', 'flow-end',
  'handoff',
  'agent-start', 'agent-end',
  'step-start', 'step-end',
  'context-compacted', 'result-evicted',
  'tripwire', 'interrupted', 'turn-end', 'custom',
]);

console.log('Stream Event Filter — E2E Leak Test');
console.log('='.repeat(50));

// Test 1: maintenance request triggers tool calls + flow transitions internally
console.log('\nTest 1: Maintenance request (triggers tools + flow transitions)');
const events1 = await captureSSEEvents('My sink is broken in unit 204B, high priority emergency');

const types1 = events1.map(e => e.type);
const uniqueTypes1 = [...new Set(types1)];
console.log(`  Events received: ${events1.length}`);
console.log(`  Event types: ${uniqueTypes1.join(', ')}`);

const leaked1 = uniqueTypes1.filter(t => INTERNAL_TYPES.has(t));
if (leaked1.length > 0) {
  console.log(`  FAIL: LEAKED INTERNAL EVENTS: ${leaked1.join(', ')}`);

  // Show what leaked
  for (const event of events1.filter(e => INTERNAL_TYPES.has(e.type))) {
    console.log(`    LEAK: ${JSON.stringify(event).slice(0, 120)}`);
  }
} else {
  console.log('  PASS: No internal events leaked');
}

// Check error sanitization
const errors1 = events1.filter(e => e.type === 'error');
for (const err of errors1) {
  if (err.error !== 'An error occurred. Please try again.') {
    console.log(`  FAIL: Unsanitized error: ${err.error}`);
  }
}

// Check text content was received
const textParts = events1.filter(e => e.type === 'text-delta');
const fullText = textParts.map(e => e.delta).join('');
console.log(`  Agent response: "${fullText.slice(0, 80)}${fullText.length > 80 ? '...' : ''}"`);

if (textParts.length === 0) {
  console.log('  WARN: No text-delta events — agent might not have responded');
}

// Test 2: Check done event has sessionId
const doneEvents = events1.filter(e => e.type === 'done');
if (doneEvents.length > 0) {
  console.log(`  Session ID: ${doneEvents[0].sessionId}`);
  console.log('  PASS: done event received');
} else {
  console.log('  WARN: No done event received');
}

// Summary
console.log('\n' + '='.repeat(50));
const totalLeaks = leaked1.length;
console.log(`RESULT: ${totalLeaks === 0 ? 'PASS — No IP leaks detected' : `FAIL — ${totalLeaks} event types leaked`}`);
console.log('='.repeat(50));

process.exit(totalLeaks > 0 ? 1 : 0);
