import { describe, expect, test } from 'bun:test';
import type { StreamPart } from '@kuralle-agents/core';
import { convertToSSELines } from '../StreamAdapter.js';
import { DEFAULT_STREAM_CONFIG } from '../types.js';

function parseSSELines(lines: string[]): Array<Record<string, unknown>> {
  return lines
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

function collect(parts: StreamPart[]) {
  const textState = { open: false, canceledIds: new Set<string>() };
  const events: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    const lines = convertToSSELines(part, DEFAULT_STREAM_CONFIG, textState);
    events.push(...parseSSELines(lines));
  }
  return events;
}

describe('StreamAdapter convertToSSELines', () => {
  test('text-start through multi-delta to text-end', () => {
    const events = collect([
      { channel: 'client', type: 'text-start', payload: { id: 't1' } },
      { channel: 'client', type: 'text-delta', payload: { id: 't1', delta: 'Hel' } },
      { channel: 'client', type: 'text-delta', payload: { id: 't1', delta: 'lo' } },
      { channel: 'client', type: 'text-end', payload: { id: 't1' } },
    ]);

    expect(events.map((e) => e.type)).toEqual([
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
    ]);
    expect(
      events
        .filter((e) => e.type === 'text-delta')
        .map((e) => e.delta)
        .join(''),
    ).toBe('Hello');
  });

  test('text-cancel closes segment and drops post-cancel deltas for that turn', () => {
    const events = collect([
      { channel: 'client', type: 'text-start', payload: { id: 'turn-1' } },
      { channel: 'client', type: 'text-delta', payload: { id: 'turn-1', delta: 'pre' } },
      {
        channel: 'client',
        type: 'text-cancel',
        payload: { id: 'turn-1', reason: 'policy-block' },
      },
      { channel: 'client', type: 'text-delta', payload: { id: 'turn-1', delta: 'leak' } },
      { channel: 'client', type: 'text-start', payload: { id: 'safe-1' } },
      { channel: 'client', type: 'text-delta', payload: { id: 'safe-1', delta: 'safe' } },
      { channel: 'client', type: 'text-end', payload: { id: 'safe-1' } },
    ]);

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'text-start',
      'text-delta',
      'text-end',
      'text-start',
      'text-delta',
      'text-end',
    ]);
    expect(
      events
        .filter((e) => e.type === 'text-delta')
        .map((e) => e.delta)
        .join(''),
    ).toBe('presafe');
    expect(
      events
        .filter((e) => e.type === 'text-delta')
        .map((e) => e.delta)
        .join(''),
    ).not.toContain('leak');
  });
});
