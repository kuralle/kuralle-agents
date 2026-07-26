import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { collect, defineFlow, reply } from '../../src/authoring/nodes.js';
import { clearFlowCollectCache } from '../../src/flow/runFlow.js';

/**
 * A collect node caches its extraction under `__collect_<nodeId>`, and that cache is meant to
 * survive turn boundaries — it is how fields accumulate over several user turns mid-flow
 * (see `core-agent/continuity.test.ts`, which asserts exactly that).
 *
 * It must NOT survive the flow itself. Re-entering a completed flow found the previous run's
 * cache already complete, finished instantly with those values, and the action node acted on
 * them. Observed live: three maintenance reports for three different units produced three
 * copies of the FIRST work order; the units actually reported were never touched.
 *
 * Hence the clear happens on fresh entry (`!run.activeNode`), not on completion — clearing at
 * completion broke mid-flow accumulation.
 */
const intake = collect({
  id: 'work_order_intake',
  schema: z.object({ unitId: z.string(), issue: z.string() }),
  required: ['unitId', 'issue'],
  instructions: () => 'Extract.',
  onComplete: () => ({ end: 'done' }),
});
const done = reply({ id: 'done', instructions: 'Done.', next: () => ({ end: 'ok' }) });
const flow = defineFlow({ name: 'raise', description: 'Raise', start: intake, nodes: [intake, done] });

describe('clearFlowCollectCache', () => {
  it("drops a collect node's cached extraction so a fresh entry re-extracts", () => {
    const state: Record<string, unknown> = {
      __collect_work_order_intake: { unitId: 'A-101', issue: 'water leak' },
      __collectTurns_work_order_intake: 1,
    };
    clearFlowCollectCache(state, flow);
    expect(state.__collect_work_order_intake).toBeUndefined();
    expect(state.__collectTurns_work_order_intake).toBeUndefined();
  });

  it('leaves extracted values in place — agents read them after a flow ends', () => {
    const state: Record<string, unknown> = {
      unitId: 'A-101',
      issue: 'water leak',
      __collect_work_order_intake: { unitId: 'A-101' },
    };
    clearFlowCollectCache(state, flow);
    expect(state.unitId).toBe('A-101');
    expect(state.issue).toBe('water leak');
  });

  it('leaves other flows and framework state alone', () => {
    const state: Record<string, unknown> = {
      __collect_some_other_flow_node: { x: 1 },
      __completedFlows: ['raise'],
      __flowParkStack: [],
    };
    clearFlowCollectCache(state, flow);
    expect(state.__collect_some_other_flow_node).toEqual({ x: 1 });
    expect(state.__completedFlows).toEqual(['raise']);
    expect(state.__flowParkStack).toEqual([]);
  });
});
