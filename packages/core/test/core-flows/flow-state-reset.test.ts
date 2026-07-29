import { readFileSync } from 'node:fs';
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
  // accessNotes is optional on purpose: an optional field answered on one report and left
  // blank on the next is the exact shape that leaked before promoted values were cleared.
  schema: z.object({ unitId: z.string(), issue: z.string(), accessNotes: z.string().optional() }),
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

  /**
   * Extracted values are promoted onto the top of `run.state` by reduceTransition, and an
   * agent reads them after the flow ends — so they must survive completion. They must NOT
   * survive into a *fresh entry* of the same flow, which is a different moment: this
   * function's only caller is the `!run.activeNode` branch in runFlow, i.e. re-entry.
   *
   * Clearing only the namespaced cache left the promoted copies behind. Because
   * projectCollectData omits any field the new extraction did not supply, an optional field
   * answered on the first report survived into the second — a work order for unit B-12
   * carrying unit A-101's access instructions.
   */
  it('clears promoted values on a fresh entry so one report cannot inherit another\'s', () => {
    const state: Record<string, unknown> = {
      unitId: 'A-101',
      issue: 'water leak',
      accessNotes: 'key under the mat, cat inside',
      __collect_work_order_intake: { unitId: 'A-101' },
    };
    clearFlowCollectCache(state, flow);
    expect(state.unitId).toBeUndefined();
    expect(state.issue).toBeUndefined();
    expect(state.accessNotes).toBeUndefined();
  });

  it('clears only the active flow frame on entry', () => {
    // Guards the call-site contract itself: if a future change starts clearing on
    // completion, the values an agent reads after a flow ends vanish.
    const src = readFileSync(
      new URL('../../src/flow/runFlow.ts', import.meta.url),
      'utf8',
    );
    const calls = src.split('clearFlowCollectCache(state, flow)').length - 1;
    expect(calls).toBe(1);
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
