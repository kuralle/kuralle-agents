import { describe, expect, it } from 'bun:test';
import {
  FlowParkOverflowError,
  MAX_FLOW_PARK_DEPTH,
  pushFlowPark,
} from '../../src/flow/collectDigression.js';
import { isDegradableRuntimeError } from '../../src/flow/degradableErrors.js';
import type { RunState } from '../../src/runtime/durable/types.js';

// Park-stack overflow is the structural twin of maxOscillations: a bounded runaway the
// framework is supposed to absorb into its degrade path. It threw a plain Error, which
// isDegradableRuntimeError does not recognise, so the turn escaped runtime.run() as an
// unhandled rejection instead of degrading like oscillation does.
describe('flow park overflow', () => {
  function stateAtDepth(depth: number): RunState {
    return {
      flowStack: Array.from({ length: depth }, (_, i) => ({
        flow: `flow-${i}`,
        node: `node-${i}`,
        state: { depth: i },
      })),
    } as unknown as RunState;
  }

  it('throws a typed error the runtime classifies as degradable', () => {
    const run = stateAtDepth(MAX_FLOW_PARK_DEPTH);
    let thrown: unknown;
    try {
      pushFlowPark(run, { flow: 'one-too-many', node: 'n', state: {} });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(FlowParkOverflowError);
    expect(isDegradableRuntimeError(thrown)).toBe(true);
  });

  it('fails closed: the existing frames are untouched by the rejected push', () => {
    const run = stateAtDepth(MAX_FLOW_PARK_DEPTH);
    const before = JSON.stringify(run.flowStack);

    expect(() => pushFlowPark(run, { flow: 'one-too-many', node: 'n', state: {} })).toThrow();

    expect(JSON.stringify(run.flowStack)).toBe(before);
    expect(run.flowStack).toHaveLength(MAX_FLOW_PARK_DEPTH);
  });

  it('still accepts a push below the bound', () => {
    const run = stateAtDepth(MAX_FLOW_PARK_DEPTH - 1);
    pushFlowPark(run, { flow: 'fits', node: 'n', state: {} });
    expect(run.flowStack).toHaveLength(MAX_FLOW_PARK_DEPTH);
  });
});
