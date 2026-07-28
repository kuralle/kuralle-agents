import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { action, collect, defineFlow } from '../../src/types/flow.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor, defineTool } from '../../src/tools/effect/index.js';
import { RecoverableToolError } from '../../src/tools/effect/errors.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import { SuspendError } from '../../src/runtime/durable/RunStore.js';
import type { StreamPart } from '../../src/types/stream.js';

/**
 * RecoverableToolError recovery used to delete the collect turn counter along with
 * the field cache. That disarmed maxTurns: re-supplying the same values reproduced
 * the identical error forever. This test drives the duplicate-record case — a
 * condition re-collection cannot fix — and asserts the counter stays monotonic and
 * the flow terminates via the existing escalate path.
 */
describe('collect recovery livelock', () => {
  it('preserves the turn counter across recoveries so maxTurns terminates the loop', async () => {
    const maxTurns = 3;
    // Cap well above the expected escalate point so a regressing counter reset fails
    // the suite instead of hanging it.
    const driverCap = maxTurns + 5;

    const createWorkOrder = defineTool({
      name: 'create_work_order',
      description: 'create',
      input: z.object({ unitId: z.string(), issue: z.string() }),
      execute: async () => {
        // Duplicate-record: re-collecting the same fields cannot fix this.
        throw new RecoverableToolError(
          "Work order WO-1041 is already open for unit 'A-204'. Cannot create a duplicate.",
        );
      },
    });

    const create = action({
      id: 'create',
      run: async (_state, ctx) => {
        await ctx.tool('create_work_order', { unitId: 'A-204', issue: 'no heat' });
        return { end: 'done' };
      },
    });

    const gather = collect({
      id: 'gather',
      schema: z.object({ unitId: z.string(), issue: z.string() }),
      required: ['unitId', 'issue'],
      maxTurns,
      ask: () => 'Which unit and what is the issue?',
      onComplete: () => create,
    });

    const flow = defineFlow({
      name: 'raise_work_order',
      description: 'Raise a work order',
      start: gather,
      nodes: [gather, create],
      // Recovery re-enters collect→action many times; keep oscillation out of the way
      // so this test isolates the turn-counter bound.
      maxOscillations: 20,
    });

    const fields = { unitId: 'A-204', issue: 'no heat' };
    const driver = {
      async runAgentTurn() {
        return { text: '', toolResults: [] };
      },
      async runExtraction() {
        return {
          text: '',
          toolResults: [
            {
              name: 'submit_gather_data',
              args: fields,
              result: fields,
              toolCallId: 'tc-dup',
            },
          ],
        };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'A-204 has no heat' };
      },
    };

    const parts: StreamPart[] = [];
    const { session, runStore, runState } = await setupDurableHarness(
      'livelock-sess',
      'livelock-run',
    );
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: { create_work_order: createWorkOrder } }),
      model: stubModel,
      emit: (part) => parts.push(part),
    });

    const turnSamples: number[] = [];
    let suspended = false;
    let suspendReason: string | undefined;

    for (let i = 0; i < driverCap; i += 1) {
      ctx.turnInputConsumed = false;
      parts.length = 0;
      try {
        const result = await runFlow(flow, runState, driver, ctx);
        if (result.kind === 'awaitingUser') {
          const raw = runState.state.__collectTurns_gather;
          const turns = typeof raw === 'number' ? raw : 0;
          turnSamples.push(turns);
          const asks = parts.filter(
            (p) => p.type === 'text-delta' && /Which unit/.test(p.payload.delta),
          ).length;
          // Each recovery park should emit exactly one ask; never unboundedly many.
          expect(asks).toBeLessThanOrEqual(1);
          continue;
        }
        // Unexpected non-park completion would also be a failure of the bound.
        expect(result.kind).not.toBe('ended');
        break;
      } catch (error) {
        suspended = error instanceof SuspendError;
        if (!suspended) throw error;
        suspendReason =
          typeof runState.waitingFor?.meta?.reason === 'string'
            ? runState.waitingFor.meta.reason
            : undefined;
        break;
      }
    }

    expect(suspended).toBe(true);
    expect(suspendReason).toMatch(/Could not collect .* for "gather" after 3 turns/);

    // Counter never returns to 0 after the first collect pass, and strictly increases
    // across recoveries. With the bug (delete collectTurnsKey on recovery) every sample
    // after a reset is 0 and this fails.
    expect(turnSamples.length).toBeGreaterThanOrEqual(2);
    expect(turnSamples[0]).toBeGreaterThan(0);
    for (let i = 1; i < turnSamples.length; i += 1) {
      expect(turnSamples[i]).toBeGreaterThan(turnSamples[i - 1]!);
    }

    // Ask emissions across the whole run are bounded by maxTurns (one re-ask per
    // recovery before the escalate path fires).
    const totalAsks = turnSamples.length;
    expect(totalAsks).toBeLessThanOrEqual(maxTurns);
  });
});
