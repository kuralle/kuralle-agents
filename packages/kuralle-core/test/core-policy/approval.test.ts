import { describe, expect, it } from 'bun:test';
import { action, defineFlow, reply } from '../../src/types/flow.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setupDurableHarness } from '../core-durable/helpers.js';

describe('declined approval routing', () => {
  it('routes to handoff when approved:false and never fires post-approval tool', async () => {
    const chargeSpy = { count: 0 };
    const toolExecutor = {
      execute: async ({ name }: { name: string }) => {
        if (name === 'charge') {
          chargeSpy.count += 1;
        }
        return { charged: true };
      },
    };

    const after = reply({ id: 'after', instructions: 'Should not run', next: () => ({ end: 'done' }) });
    const approval = action({
      id: 'approve-charge',
      run: async (_state, ctx) => {
        const decision = await ctx.approve({ title: 'Charge $10?' });
        if (!decision.approved) {
          return { handoff: 'human', reason: 'declined' };
        }
        await ctx.tool('charge', { amount: 10 });
        return after;
      },
    });

    const flow = defineFlow({
      name: 'approval-decline',
      description: 'Declined approval',
      start: approval,
      nodes: [approval, after],
    });

    const driver = {
      async runAgentTurn() {
        return { text: 'n/a', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'x' };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness('decline-sess', 'decline-run');
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor,
      model: {} as import('ai').LanguageModel,
      emit: () => {},
    });

    await expect(runFlow(flow, runState, driver, ctx)).rejects.toBeInstanceOf(
      (await import('../../src/runtime/durable/RunStore.js')).SuspendError,
    );

    const { recordSignalDelivery } = await import('../../src/runtime/durable/replay.js');
    const paused = (await runStore.getRunState(runState.runId))!;
    await recordSignalDelivery(runStore, paused, {
      signalId: 'sig-decline',
      name: '__approval',
      payload: { approved: false, by: 'supervisor' },
    });

    const resumed = (await runStore.getRunState(runState.runId))!;
    const ctx2 = await createRunContext({
      session,
      runStore,
      runState: resumed,
      steps: await runStore.getSteps(runState.runId),
      toolExecutor,
      model: {} as import('ai').LanguageModel,
      emit: () => {},
    });

    const result = await runFlow(flow, resumed, driver, ctx2);
    expect(result).toEqual({ kind: 'handoff', to: 'human', reason: 'declined' });
    expect(chargeSpy.count).toBe(0);
  });
});
