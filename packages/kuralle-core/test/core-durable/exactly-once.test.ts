import { describe, expect, it } from 'bun:test';
import { SuspendError } from '../../src/runtime/durable/RunStore.js';
import { buildCtx, reloadRunState, setupDurableHarness } from './helpers.js';

describe('core-v2 durable exactly-once', () => {
  it('ctx.tool executes the side effect once across persist + handler re-execution', async () => {
    const chargeSpy = { count: 0 };
    const toolExecutor = {
      execute: async ({ name }: { name: string; args: unknown; session: unknown }) => {
        if (name !== 'charge') {
          throw new Error(`Unexpected tool: ${name}`);
        }
        chargeSpy.count += 1;
        return { charged: true, amount: 100 };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness();

    async function chargeHandler(ctx: Awaited<ReturnType<typeof buildCtx>>) {
      return ctx.tool('charge', { amount: 100 });
    }

    const ctx1 = await buildCtx({ session, runStore, runState, toolExecutor });
    const firstResult = await chargeHandler(ctx1);
    expect(firstResult).toEqual({ charged: true, amount: 100 });
    expect(chargeSpy.count).toBe(1);

    const stepsAfterFirstRun = await runStore.getSteps(runState.runId);
    expect(stepsAfterFirstRun).toHaveLength(1);
    expect(stepsAfterFirstRun[0]?.kind).toBe('tool');
    expect(stepsAfterFirstRun[0]?.name).toBe('charge');

    const reloaded = await reloadRunState(runStore, runState.runId);
    const ctx2 = await buildCtx({ session, runStore, runState: reloaded, toolExecutor });
    const secondResult = await chargeHandler(ctx2);

    expect(secondResult).toEqual({ charged: true, amount: 100 });
    expect(chargeSpy.count).toBe(1);
    expect(await runStore.getSteps(runState.runId)).toHaveLength(1);
  });
});

describe('core-v2 durable pause', () => {
  it('ctx.approve suspends, persists waitingFor, and resumes idempotently on delivery', async () => {
    const toolExecutor = { execute: async () => ({}) };
    const { session, runStore, runState } = await setupDurableHarness();
    const pausedEvents: string[] = [];

    async function approvalHandler(ctx: Awaited<ReturnType<typeof buildCtx>>) {
      const approval = await ctx.approve({ title: 'Refund $50?' });
      return approval;
    }

    const ctx1 = await buildCtx({
      session,
      runStore,
      runState,
      toolExecutor,
      emit: (part) => {
        if (part.type === 'paused') pausedEvents.push(part.waitingFor);
      },
    });

    await expect(approvalHandler(ctx1)).rejects.toBeInstanceOf(SuspendError);

    const pausedState = await reloadRunState(runStore, runState.runId);
    expect(pausedState.status).toBe('paused');
    expect(pausedState.waitingFor?.signalName).toBe('__approval');
    expect(pausedEvents).toEqual(['__approval']);
    expect(await runStore.getSteps(runState.runId)).toHaveLength(0);

    const { recordSignalDelivery } = await import('../../src/runtime/durable/replay.js');
    const delivery = {
      signalId: 'sig-approve-1',
      name: '__approval',
      payload: { approved: true, by: 'supervisor' },
    };

    const recorded = await recordSignalDelivery(runStore, pausedState, delivery);
    expect(recorded).toBe(true);
    expect(await runStore.getSteps(runState.runId)).toHaveLength(1);

    const resumedState = await reloadRunState(runStore, runState.runId);
    expect(resumedState.status).toBe('running');
    expect(resumedState.waitingFor).toBeUndefined();

    const ctx2 = await buildCtx({
      session,
      runStore,
      runState: resumedState,
      toolExecutor,
    });
    const result = await approvalHandler(ctx2);
    expect(result).toEqual({ approved: true, by: 'supervisor' });

    const duplicate = await recordSignalDelivery(runStore, resumedState, delivery);
    expect(duplicate).toBe(false);
    expect(await runStore.getSteps(runState.runId)).toHaveLength(1);

    const ctx3 = await buildCtx({
      session,
      runStore,
      runState: await reloadRunState(runStore, runState.runId),
      toolExecutor,
    });
    const replayed = await approvalHandler(ctx3);
    expect(replayed).toEqual({ approved: true, by: 'supervisor' });
  });

  it('ctx.signal resumes with payload and duplicate delivery is idempotent', async () => {
    const toolExecutor = { execute: async () => ({}) };
    const { session, runStore, runState } = await setupDurableHarness();

    async function signalHandler(ctx: Awaited<ReturnType<typeof buildCtx>>) {
      return ctx.signal('payment_confirmed', { meta: { orderId: 'ord-9' } });
    }

    const ctx1 = await buildCtx({ session, runStore, runState, toolExecutor });
    await expect(signalHandler(ctx1)).rejects.toBeInstanceOf(SuspendError);

    const pausedState = await reloadRunState(runStore, runState.runId);
    expect(pausedState.waitingFor?.signalName).toBe('payment_confirmed');

    const { recordSignalDelivery } = await import('../../src/runtime/durable/replay.js');
    const delivery = {
      signalId: 'sig-pay-1',
      name: 'payment_confirmed',
      payload: { confirmed: true },
    };

    await recordSignalDelivery(runStore, pausedState, delivery);

    const ctx2 = await buildCtx({
      session,
      runStore,
      runState: await reloadRunState(runStore, runState.runId),
      toolExecutor,
    });
    expect(await signalHandler(ctx2)).toEqual({ confirmed: true });

    const dup = await recordSignalDelivery(
      runStore,
      await reloadRunState(runStore, runState.runId),
      delivery,
    );
    expect(dup).toBe(false);
    expect(await runStore.getSteps(runState.runId)).toHaveLength(1);
  });
});
