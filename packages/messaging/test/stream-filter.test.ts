import { describe, it, expect } from 'bun:test';
import type { StreamPart } from '@kuralle-agents/core';
import { filterStreamParts } from '../src/stream-filter.js';

const parts: StreamPart[] = [
  {
    channel: 'client',
    type: 'text-delta',
    payload: { id: 't0', delta: 'hello ' },
  },
  {
    channel: 'internal',
    type: 'tool-call',
    payload: { toolCallId: 't1', toolName: 'search', args: { q: 'x' } },
  },
  {
    channel: 'client',
    type: 'text-delta',
    payload: { id: 't0', delta: 'world' },
  },
  {
    channel: 'internal',
    type: 'handoff',
    payload: { targetAgent: 'a2', reason: 'transfer' },
  },
  { channel: 'client', type: 'done', payload: { sessionId: 'session-1' } },
];

describe('filterStreamParts', () => {
  it('narrows text-delta parts and preserves the text property', () => {
    const texts = parts.filter(filterStreamParts.textDelta).map((p) => p.payload.delta);
    expect(texts).toEqual(['hello ', 'world']);
  });

  it('narrows tool-call parts', () => {
    const calls = parts.filter(filterStreamParts.toolCall);
    expect(calls).toHaveLength(1);
    expect(calls[0].payload.toolName).toBe('search');
  });

  it('narrows handoff parts with targetAgent/reason fields', () => {
    const h = parts.find(filterStreamParts.handoff);
    expect(h?.payload.targetAgent).toBe('a2');
    expect(h?.payload.reason).toBe('transfer');
  });

  it('narrows done with sessionId', () => {
    const d = parts.find(filterStreamParts.done);
    expect(d?.payload.sessionId).toBe('session-1');
  });
});
