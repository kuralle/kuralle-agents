import { describe, expect, it } from 'bun:test';
import { reduce, type LoggedEvent } from '../src/reduce.js';
import { logged, toolTurnEvents } from './fixtures.js';

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const textHalf1: LoggedEvent[] = [
  logged(0, { channel: 'client', type: 'text-start', payload: { id: 'a' } }, { at: 1000 }),
  logged(1, { channel: 'client', type: 'text-delta', payload: { id: 'a', delta: 'Hello ' } }, { at: 1001 }),
];
const textHalf2: LoggedEvent[] = [
  logged(1, { channel: 'client', type: 'text-delta', payload: { id: 'a', delta: 'Hello ' } }, { at: 1001 }),
  logged(2, { channel: 'client', type: 'text-delta', payload: { id: 'a', delta: 'world' } }, { at: 1002 }),
  logged(3, { channel: 'client', type: 'text-end', payload: { id: 'a' } }, { at: 1003 }),
];

describe('reduce JSON round-trip', () => {
  it('continues one assistant block after serialising a partial view', () => {
    const partial = reduce(textHalf1);
    const piped = roundTrip(partial);
    const view = reduce(textHalf2, piped);

    const assistants = view.blocks.filter((b) => b.kind === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ text: 'Hello world', streaming: false });
  });

  it('resolves tool results after serialising mid tool-call', () => {
    const split = 4;
    const overlap = 1;
    const first = toolTurnEvents.slice(0, split);
    const second = toolTurnEvents.slice(split - overlap);

    const partial = reduce(first);
    const piped = roundTrip(partial);
    const view = reduce(second, piped);

    const tool = view.blocks.find((b) => b.kind === 'tool' && b.id === 'call-1');
    expect(tool).toMatchObject({
      name: 'lookup_order',
      state: 'ok',
      result: { status: 'shipped', carrier: 'DHL' },
      ms: 200,
    });
  });
});
