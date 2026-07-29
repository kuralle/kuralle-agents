import { describe, expect, it } from 'bun:test';
import { pushFlowPark, popFlowPark, getFlowPark } from '../../src/flow/collectDigression.js';
import { makeRunState } from '../core-durable/helpers.js';

describe('G1: __flowPark is a stack, not a single slot', () => {
  it('nested pivots resume LIFO (A pushed, B pushed → pop B, then A)', () => {
    const run = makeRunState('park-session');
    pushFlowPark(run, { flow: 'A', node: 'a1', state: { a: 1 } });
    pushFlowPark(run, { flow: 'B', node: 'b1', state: { b: 2 } });
    expect(getFlowPark(run)).toEqual({ flow: 'B', node: 'b1', state: { b: 2 } });
    expect(popFlowPark(run)).toEqual({ flow: 'B', node: 'b1', state: { b: 2 } });
    expect(popFlowPark(run)).toEqual({ flow: 'A', node: 'a1', state: { a: 1 } });
    expect(popFlowPark(run)).toBeUndefined();
  });

  it('rejects overflow instead of silently discarding the outer frame', () => {
    const run = makeRunState('park-overflow');
    for (let index = 0; index < 8; index += 1) {
      pushFlowPark(run, {
        flow: `flow-${index}`,
        node: `node-${index}`,
        state: { index },
      });
    }

    expect(() =>
      pushFlowPark(run, {
        flow: 'overflow',
        node: 'overflow-node',
        state: {},
      }),
    ).toThrow('Flow park depth exceeds 8');
    expect(run.flowStack?.[0]?.flow).toBe('flow-0');
  });
});
