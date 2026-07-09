import { describe, test, expect } from 'bun:test';
import { ChatCtxMirror } from '../chat-ctx-mirror.js';

describe('ChatCtxMirror — upsert + transcripts', () => {
  test('upsert adds new items in insertion order', () => {
    const m = new ChatCtxMirror();
    m.upsert({ id: 'i1', type: 'message', role: 'user', content: [] });
    m.upsert({ id: 'i2', type: 'message', role: 'assistant', content: [] });
    const snap = m.snapshot();
    expect(snap).toHaveLength(2);
    expect(snap[0].itemId).toBe('i1');
    expect(snap[1].itemId).toBe('i2');
    expect(snap[0].position).toBe(0);
    expect(snap[1].position).toBe(1);
  });

  test('upsert is idempotent on same id', () => {
    const m = new ChatCtxMirror();
    m.upsert({ id: 'i1', type: 'message', role: 'user', content: [] });
    m.upsert({ id: 'i1', type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] });
    expect(m.size()).toBe(1);
    const item = m.getById('i1')!;
    expect(item.content).toEqual([{ type: 'input_text', text: 'hi' }]);
  });

  test('applyTranscript replaces content for user role', () => {
    const m = new ChatCtxMirror();
    m.upsert({ id: 'u1', type: 'message', role: 'user', content: [] });
    m.applyTranscript('u1', 'user', 'hello there');
    const item = m.getById('u1')!;
    expect(item.content).toEqual([{ type: 'input_text', text: 'hello there' }]);
  });

  test('applyTranscript replaces content for assistant role (output_text)', () => {
    const m = new ChatCtxMirror();
    m.upsert({ id: 'a1', type: 'message', role: 'assistant', content: [] });
    m.applyTranscript('a1', 'assistant', 'hi there');
    const item = m.getById('a1')!;
    expect(item.content).toEqual([{ type: 'output_text', text: 'hi there' }]);
  });

  test('applyTranscript on unknown id creates a placeholder', () => {
    const m = new ChatCtxMirror();
    m.applyTranscript('ghost', 'user', 'oops');
    expect(m.size()).toBe(1);
    expect(m.getById('ghost')?.content).toEqual([{ type: 'input_text', text: 'oops' }]);
  });
});

describe('ChatCtxMirror — replay frame sequence', () => {
  test('toCreateFrames emits items in chain order with previous_item_id', () => {
    const m = new ChatCtxMirror();
    m.upsert({ id: 'u1', type: 'message', role: 'user', content: [] });
    m.applyTranscript('u1', 'user', 'first');
    m.upsert({ id: 'a1', type: 'message', role: 'assistant', content: [] });
    m.applyTranscript('a1', 'assistant', 'reply');
    m.upsert({ id: 'u2', type: 'message', role: 'user', content: [] });
    m.applyTranscript('u2', 'user', 'second');

    const frames = m.toCreateFrames();
    expect(frames).toHaveLength(3);
    expect(frames[0]).toMatchObject({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'first' }] },
    });
    expect((frames[0] as Record<string, unknown>).previous_item_id).toBeUndefined();

    expect(frames[1]).toMatchObject({
      type: 'conversation.item.create',
      previous_item_id: 'u1',
      item: { type: 'message', role: 'assistant' },
    });
    expect(frames[2]).toMatchObject({
      type: 'conversation.item.create',
      previous_item_id: 'a1',
      item: { type: 'message', role: 'user' },
    });
  });

  test('toCreateFrames excludes function_call_output items', () => {
    const m = new ChatCtxMirror();
    m.upsert({ id: 'u1', type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] });
    m.upsert({ id: 'fc1', type: 'function_call_output', role: 'assistant', content: [{ result: 'ok' }] });
    m.upsert({ id: 'a1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] });
    const frames = m.toCreateFrames();
    // Only the two message items — function_call_output intentionally skipped.
    expect(frames).toHaveLength(2);
  });

  test('toCreateFrames skips empty-content items (interrupted turns)', () => {
    const m = new ChatCtxMirror();
    m.upsert({ id: 'empty', type: 'message', role: 'user', content: [] });
    m.upsert({ id: 'full', type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] });
    const frames = m.toCreateFrames();
    expect(frames).toHaveLength(1);
  });
});

describe('ChatCtxMirror — hydrate', () => {
  test('restores state from persisted snapshot and continues numbering', () => {
    const m = new ChatCtxMirror();
    m.hydrate([
      { itemId: 'a', role: 'user', kind: 'message', content: [{ type: 'input_text', text: '1' }], position: 0 },
      { itemId: 'b', role: 'assistant', kind: 'message', content: [{ type: 'output_text', text: '2' }], position: 1 },
    ]);
    expect(m.size()).toBe(2);
    m.upsert({ id: 'c', type: 'message', role: 'user', content: [] });
    const c = m.getById('c')!;
    expect(c.position).toBe(2);
  });

  test('hydrate sorts by position', () => {
    const m = new ChatCtxMirror();
    m.hydrate([
      { itemId: 'b', role: 'assistant', kind: 'message', content: [{ type: 'output_text', text: '2' }], position: 1 },
      { itemId: 'a', role: 'user', kind: 'message', content: [{ type: 'input_text', text: '1' }], position: 0 },
    ]);
    const snap = m.snapshot();
    expect(snap[0].itemId).toBe('a');
    expect(snap[1].itemId).toBe('b');
  });
});
