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

describe('approved approval round-trip', () => {
  it('pauses on approve, resumes once, fires the post-approval tool exactly once, and replays on retry', async () => {
    const chargeSpy = { count: 0 };
    const toolExecutor = {
      execute: async ({ name }: { name: string }) => {
        if (name === 'charge') chargeSpy.count += 1;
        return { charged: true, amount: 10 };
      },
    };

    const done = reply({ id: 'done', instructions: 'Confirm the charge', next: () => ({ end: 'completed' }) });
    const approval = action({
      id: 'approve-charge',
      run: async (_state, ctx) => {
        const decision = await ctx.approve({ title: 'Charge $10?', description: 'verbal ok' });
        if (!decision.approved) {
          return { handoff: 'human', reason: 'declined' };
        }
        await ctx.tool('charge', { amount: 10 });
        return done;
      },
    });
    const flow = defineFlow({
      name: 'approval-approve',
      description: 'Approved approval',
      start: approval,
      nodes: [approval, done],
    });

    const driver = {
      async runAgentTurn() {
        return { text: 'ok', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'x' };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness('approve-sess', 'approve-run');
    const { SuspendError } = await import('../../src/runtime/durable/RunStore.js');
    const { recordSignalDelivery } = await import('../../src/runtime/durable/replay.js');

    // Turn 1: suspends on approve; the post-approval tool must NOT fire.
    const parts1: import('../../src/types/stream.js').HarnessStreamPart[] = [];
    const ctx1 = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor,
      model: {} as import('ai').LanguageModel,
      emit: (part) => parts1.push(part),
    });
    await expect(runFlow(flow, runState, driver, ctx1)).rejects.toBeInstanceOf(SuspendError);

    const paused = (await runStore.getRunState(runState.runId))!;
    expect(paused.status).toBe('paused');
    expect(paused.waitingFor?.signalName).toBe('__approval');
    expect(chargeSpy.count).toBe(0);
    expect(parts1.some((part) => part.type === 'paused' && part.waitingFor === '__approval')).toBe(true);
    expect(
      (await runStore.getSteps(runState.runId)).filter((step) => step.kind === 'tool' && step.name === 'charge'),
    ).toHaveLength(0);

    // Deliver approval=true.
    await recordSignalDelivery(runStore, paused, {
      signalId: 'sig-approve',
      name: '__approval',
      payload: { approved: true, by: 'supervisor' },
    });

    // Turn 2: resumes; the post-approval tool fires exactly once.
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
    expect(result).toEqual({ kind: 'ended', reason: 'completed' });
    expect((await runStore.getRunState(runState.runId))!.status).not.toBe('paused');
    expect(chargeSpy.count).toBe(1);
    expect(
      (await runStore.getSteps(runState.runId)).filter((step) => step.kind === 'tool' && step.name === 'charge'),
    ).toHaveLength(1);

    // Turn 3 (retry): re-running the resumed flow replays the effect log — no double charge.
    const replayState = (await runStore.getRunState(runState.runId))!;
    const ctx3 = await createRunContext({
      session,
      runStore,
      runState: replayState,
      steps: await runStore.getSteps(runState.runId),
      toolExecutor,
      model: {} as import('ai').LanguageModel,
      emit: () => {},
    });
    await runFlow(flow, replayState, driver, ctx3);
    expect(chargeSpy.count).toBe(1);
  });
});
