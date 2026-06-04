import { describe, it, expect } from 'bun:test';
import type { HarnessStreamPart } from '@kuralle-agents/core';
import { filterStreamParts } from '../src/stream-filter.js';

const parts: HarnessStreamPart[] = [
  { type: 'text-delta', id: 't0', delta: 'hello ' },
  { type: 'tool-call', toolCallId: 't1', toolName: 'search', args: { q: 'x' } },
  { type: 'text-delta', id: 't0', delta: 'world' },
  { type: 'handoff', targetAgent: 'a2', reason: 'transfer' },
  { type: 'done', sessionId: 'session-1' },
];

describe('filterStreamParts', () => {
  it('narrows text-delta parts and preserves the text property', () => {
    const texts = parts.filter(filterStreamParts.textDelta).map((p) => p.delta);
    expect(texts).toEqual(['hello ', 'world']);
  });

  it('narrows tool-call parts', () => {
    const calls = parts.filter(filterStreamParts.toolCall);
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe('search');
  });

  it('narrows handoff parts with targetAgent/reason fields', () => {
    const h = parts.find(filterStreamParts.handoff);
    expect(h?.targetAgent).toBe('a2');
    expect(h?.reason).toBe('transfer');
  });

  it('narrows done with sessionId', () => {
    const d = parts.find(filterStreamParts.done);
    expect(d?.sessionId).toBe('session-1');
  });
});
