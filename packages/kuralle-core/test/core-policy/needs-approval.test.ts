import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { action, defineFlow, reply } from '../../src/types/flow.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import { ToolApprovalDeniedError } from '../../src/tools/effect/errors.js';
import { SuspendError } from '../../src/runtime/durable/RunStore.js';
import { recordSignalDelivery } from '../../src/runtime/durable/replay.js';
import { setupDurableHarness } from '../core-durable/helpers.js';

const driver = {
  async runAgentTurn() {
    return { text: 'ok', toolResults: [] };
  },
  async awaitUser() {
    return { type: 'message' as const, input: 'x' };
  },
};

function build(spy: { count: number }) {
  const charge = defineTool({
    name: 'charge',
    description: 'Charge the customer',
    needsApproval: true,
    input: z.object({ amount: z.number() }),
    execute: async () => {
      spy.count += 1;
      return { charged: true };
    },
  });
  const done = reply({ id: 'done', instructions: 'Confirm', next: () => ({ end: 'completed' }) });
  // The action calls the tool BY NAME (no def passed) — exercises executor.getTool().
  const act = action({
    id: 'charge-it',
    run: async (_s, ctx) => {
      await ctx.tool('charge', { amount: 10 });
      return done;
    },
  });
  const flow = defineFlow({ name: 'needs-approval', description: 'gated tool', start: act, nodes: [act, done] });
  const executor = new CoreToolExecutor({ tools: { charge } });
  return { flow, executor };
}

describe('needsApproval tool gating', () => {
  it('suspends before a needsApproval tool runs, then runs it exactly once on approval', async () => {
    const spy = { count: 0 };
    const { flow, executor } = build(spy);
    const { session, runStore, runState } = await setupDurableHarness('na-approve-sess', 'na-approve-run');

    const ctx1 = await createRunContext({
      session, runStore, runState, steps: [], toolExecutor: executor,
      model: {} as import('ai').LanguageModel, emit: () => {},
    });
    await expect(runFlow(flow, runState, driver, ctx1)).rejects.toBeInstanceOf(SuspendError);

    const paused = (await runStore.getRunState(runState.runId))!;
    expect(paused.status).toBe('paused');
    expect(paused.waitingFor?.signalName).toBe('__approval');
    expect(spy.count).toBe(0); // gate held — tool did NOT run

    await recordSignalDelivery(runStore, paused, {
      signalId: 'sig-na-approve', name: '__approval', payload: { approved: true, by: 'mgr' },
    });

    const resumed = (await runStore.getRunState(runState.runId))!;
    const ctx2 = await createRunContext({
      session, runStore, runState: resumed, steps: await runStore.getSteps(runState.runId),
      toolExecutor: executor, model: {} as import('ai').LanguageModel, emit: () => {},
    });
    const result = await runFlow(flow, resumed, driver, ctx2);
    expect(result).toEqual({ kind: 'ended', reason: 'completed' });
    expect(spy.count).toBe(1); // ran exactly once after approval
  });

  it('throws ToolApprovalDeniedError and never runs the tool when denied', async () => {
    const spy = { count: 0 };
    const { flow, executor } = build(spy);
    const { session, runStore, runState } = await setupDurableHarness('na-deny-sess', 'na-deny-run');

    const ctx1 = await createRunContext({
      session, runStore, runState, steps: [], toolExecutor: executor,
      model: {} as import('ai').LanguageModel, emit: () => {},
    });
    await expect(runFlow(flow, runState, driver, ctx1)).rejects.toBeInstanceOf(SuspendError);

    const paused = (await runStore.getRunState(runState.runId))!;
    await recordSignalDelivery(runStore, paused, {
      signalId: 'sig-na-deny', name: '__approval', payload: { approved: false, by: 'mgr' },
    });

    const resumed = (await runStore.getRunState(runState.runId))!;
    const ctx2 = await createRunContext({
      session, runStore, runState: resumed, steps: await runStore.getSteps(runState.runId),
      toolExecutor: executor, model: {} as import('ai').LanguageModel, emit: () => {},
    });
    await expect(runFlow(flow, resumed, driver, ctx2)).rejects.toBeInstanceOf(ToolApprovalDeniedError);
    expect(spy.count).toBe(0); // denied — tool never ran
  });
});
