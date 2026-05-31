import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  removeToolHistory,
  keepRecentMessages,
  removeKeys,
  composeFilters,
} from '../../dist/runtime/handoffFilters.js';

const baseData = {
  sourceAgentId: 'agent-a',
  targetAgentId: 'agent-b',
  reason: 'routing',
};

// ===== removeToolHistory =====

test('removeToolHistory: remove tool messages', () => {
  const data = {
    ...baseData,
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'tool', content: 'tool result data' },
    ],
    workingMemory: {},
  };
  const result = removeToolHistory(data);
  assert.ok(result.messages.every((m) => m.role !== 'tool'));
  assert.strictEqual(result.messages.length, 2);
});

test('removeToolHistory: remove tool-call-only assistant messages', () => {
  const data = {
    ...baseData,
    messages: [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: '1', toolName: 'search', args: {} }],
      },
    ],
    workingMemory: {},
  };
  const result = removeToolHistory(data);
  assert.strictEqual(result.messages.length, 1);
});

test('removeToolHistory: preserve mixed assistant messages', () => {
  const data = {
    ...baseData,
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check' },
          { type: 'tool-call', toolCallId: '1', toolName: 'search', args: {} },
        ],
      },
    ],
    workingMemory: {},
  };
  const result = removeToolHistory(data);
  assert.strictEqual(result.messages.length, 1, 'Mixed messages should be preserved');
});

test('removeToolHistory: preserve user and system messages', () => {
  const data = {
    ...baseData,
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'question' },
      { role: 'tool', content: 'data' },
    ],
    workingMemory: {},
  };
  const result = removeToolHistory(data);
  assert.ok(result.messages.some((m) => m.role === 'system'));
  assert.ok(result.messages.some((m) => m.role === 'user'));
});

test('removeToolHistory: pass workingMemory through unchanged', () => {
  const wm = { key: 'value' };
  const data = {
    ...baseData,
    messages: [{ role: 'tool', content: 'data' }],
    workingMemory: wm,
  };
  const result = removeToolHistory(data);
  assert.deepStrictEqual(result.workingMemory, wm);
});

// ===== keepRecentMessages =====

test('keepRecentMessages: keep last N messages', () => {
  const data = {
    ...baseData,
    messages: [
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'msg2' },
      { role: 'user', content: 'msg3' },
      { role: 'assistant', content: 'msg4' },
    ],
    workingMemory: {},
  };
  const filter = keepRecentMessages(2);
  const result = filter(data);
  assert.strictEqual(result.messages.length, 2);
  assert.strictEqual(result.messages[0].content, 'msg3');
  assert.strictEqual(result.messages[1].content, 'msg4');
});

test('keepRecentMessages: preserve system messages regardless of count', () => {
  const data = {
    ...baseData,
    messages: [
      { role: 'system', content: 'instructions' },
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'msg2' },
    ],
    workingMemory: {},
  };
  const filter = keepRecentMessages(1);
  const result = filter(data);
  assert.ok(result.messages.some((m) => m.role === 'system'));
  // system + 1 recent
  assert.strictEqual(result.messages.length, 2);
});

test('keepRecentMessages: N > total returns all messages', () => {
  const data = {
    ...baseData,
    messages: [
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'msg2' },
    ],
    workingMemory: {},
  };
  const filter = keepRecentMessages(100);
  const result = filter(data);
  assert.strictEqual(result.messages.length, 2);
});

test('keepRecentMessages: N = 0 keeps only system messages', () => {
  const data = {
    ...baseData,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'msg1' },
    ],
    workingMemory: {},
  };
  const filter = keepRecentMessages(0);
  const result = filter(data);
  assert.strictEqual(result.messages.length, 1);
  assert.strictEqual(result.messages[0].role, 'system');
});

// ===== removeKeys =====

test('removeKeys: remove specified keys', () => {
  const data = {
    ...baseData,
    messages: [{ role: 'user', content: 'hi' }],
    workingMemory: { keep: 'yes', remove: 'no', alsoRemove: 'no' },
  };
  const filter = removeKeys(['remove', 'alsoRemove']);
  const result = filter(data);
  assert.deepStrictEqual(result.workingMemory, { keep: 'yes' });
});

test('removeKeys: preserve other keys', () => {
  const data = {
    ...baseData,
    messages: [],
    workingMemory: { a: 1, b: 2, c: 3 },
  };
  const filter = removeKeys(['b']);
  const result = filter(data);
  assert.deepStrictEqual(result.workingMemory, { a: 1, c: 3 });
});

test('removeKeys: pass messages through unchanged', () => {
  const msgs = [{ role: 'user', content: 'hi' }];
  const data = { ...baseData, messages: msgs, workingMemory: { key: 'val' } };
  const filter = removeKeys(['key']);
  const result = filter(data);
  assert.deepStrictEqual(result.messages, msgs);
});

test('removeKeys: nonexistent keys are ignored', () => {
  const data = {
    ...baseData,
    messages: [],
    workingMemory: { a: 1 },
  };
  const filter = removeKeys(['nonexistent']);
  const result = filter(data);
  assert.deepStrictEqual(result.workingMemory, { a: 1 });
});

// ===== composeFilters =====

test('composeFilters: left-to-right execution', async () => {
  const order = [];
  const f1 = (data) => { order.push('f1'); return { messages: data.messages, workingMemory: data.workingMemory }; };
  const f2 = (data) => { order.push('f2'); return { messages: data.messages, workingMemory: data.workingMemory }; };

  const composed = composeFilters(f1, f2);
  await composed({ ...baseData, messages: [], workingMemory: {} });
  assert.deepStrictEqual(order, ['f1', 'f2']);
});

test('composeFilters: output piping', async () => {
  const addMessage = (data) => ({
    messages: [...data.messages, { role: 'system', content: 'injected' }],
    workingMemory: data.workingMemory,
  });
  const countMessages = (data) => ({
    messages: data.messages,
    workingMemory: { ...data.workingMemory, count: data.messages.length },
  });

  const composed = composeFilters(addMessage, countMessages);
  const result = await composed({ ...baseData, messages: [], workingMemory: {} });
  assert.strictEqual(result.workingMemory.count, 1);
});

test('composeFilters: single filter works', async () => {
  const filter = removeKeys(['x']);
  const composed = composeFilters(filter);
  const result = await composed({
    ...baseData,
    messages: [],
    workingMemory: { x: 1, y: 2 },
  });
  assert.deepStrictEqual(result.workingMemory, { y: 2 });
});

test('composeFilters: zero filters returns input', async () => {
  const composed = composeFilters();
  const msgs = [{ role: 'user', content: 'hi' }];
  const wm = { key: 'value' };
  const result = await composed({ ...baseData, messages: msgs, workingMemory: wm });
  assert.deepStrictEqual(result.messages, msgs);
  assert.deepStrictEqual(result.workingMemory, wm);
});

test('composeFilters: async filters work', async () => {
  const asyncFilter = async (data) => {
    await new Promise((r) => setTimeout(r, 1));
    return { messages: data.messages, workingMemory: { ...data.workingMemory, async: true } };
  };
  const composed = composeFilters(asyncFilter);
  const result = await composed({ ...baseData, messages: [], workingMemory: {} });
  assert.strictEqual(result.workingMemory.async, true);
});
