import { describe, expect, it } from 'bun:test';
import { pushFlowPark, popFlowPark, getFlowPark } from '../../src/flow/collectDigression.js';

describe('G1: __flowPark is a stack, not a single slot', () => {
  it('nested pivots resume LIFO (A pushed, B pushed → pop B, then A)', () => {
    const state: Record<string, unknown> = {};
    pushFlowPark(state, { flow: 'A', node: 'a1' });
    pushFlowPark(state, { flow: 'B', node: 'b1' });
    expect(getFlowPark(state)).toEqual({ flow: 'B', node: 'b1' }); // peek top
    expect(popFlowPark(state)).toEqual({ flow: 'B', node: 'b1' });
    expect(popFlowPark(state)).toEqual({ flow: 'A', node: 'a1' }); // A survived B's push (bug: it would be lost)
    expect(popFlowPark(state)).toBeUndefined();
  });
});