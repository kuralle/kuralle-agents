import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { collect, defineFlow } from '../../src/types/flow.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import { SuspendError } from '../../src/runtime/durable/RunStore.js';

/**
 * Running out of turns is not the same as finishing.
 *
 * collectUntilComplete used to call onComplete on maxTurns exhaustion regardless of whether
 * the required fields were there. For an intake SOP that hands the rest of the flow a
 * half-filled record and lets an action node create something from whatever was in state —
 * the exact failure mode the typed collect node exists to prevent.
 */
describe('collect maxTurns exhaustion', () => {
  it('escalates instead of completing when required fields are still missing', async () => {
    let completedWith: unknown = 'NEVER CALLED';
    const intake = collect({
      id: 'intake',
      schema: z.object({ unitId: z.string(), issue: z.string() }),
      required: ['unitId', 'issue'],
      maxTurns: 1,
      instructions: () => 'Extract the unit and the issue.',
      onComplete: (data) => {
        completedWith = data;
        return { end: 'ok' };
      },
    });
    const flow = defineFlow({
      name: 'intake-flow',
      description: 'intake',
      start: intake,
      nodes: [intake],
    });

    // A driver that keeps supplying input the stub model never turns into fields.
    const driver = {
      async runAgentTurn() {
        return { text: '', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'uh, not sure' };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness(
      'collect-maxturns-sess',
      'collect-maxturns-run',
    );
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
    });

    // Drive past maxTurns. runFlow reports an unfinished collect as 'awaitingUser'.
    // Exhaustion escalates, and an escalation parks the run by throwing SuspendError —
    // that throw IS the pass condition; the failure mode is a clean completion instead.
    let suspended = false;
    try {
      for (let i = 0; i < 6; i += 1) {
        ctx.turnInputConsumed = false;
        const result = await runFlow(flow, runState, driver, ctx);
        if (result.kind !== 'awaitingUser') {
          expect(result.kind).not.toBe('ended');
          break;
        }
      }
    } catch (error) {
      suspended = error instanceof SuspendError;
      if (!suspended) throw error;
    }

    expect(suspended).toBe(true);
    expect(completedWith).toBe('NEVER CALLED');
  });
});
