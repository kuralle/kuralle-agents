import { describe, expect, it } from 'bun:test';
import type { AnyTool } from '../../src/types/effectTool.js';
import type { EffectToolExecutor } from '../../src/types/run-context.js';
import { recordSignalDelivery } from '../../src/runtime/durable/replay.js';
import { buildCtx, reloadRunState, setupDurableHarness } from './helpers.js';

// An approval is durably decided in one write and the frozen operation executes in the
// next. A crash in that window used to orphan the decision forever: `waitingFor` was
// already cleared, and `resumePendingInterrupt` — the only consumer of a frozen
// operation — is gated on `waitingFor`, so nothing ever noticed an approved-but-unrun
// operation. No error, no audit, no retry. The approval survives the crash instead.
describe('interrupt crash recovery', () => {
  function harnessTool(): {
    def: AnyTool;
    executor: EffectToolExecutor;
    count: () => number;
  } {
    let executions = 0;
    const def = { name: 'destructive', needsApproval: true } as unknown as AnyTool;
    return {
      def,
      executor: {
        execute: async ({ name }: { name: string }) => {
          if (name !== 'destructive') throw new Error(`unexpected tool ${name}`);
          executions += 1;
          return { dispatched: true, amount: 320 };
        },
        getTool: () => def,
      },
      count: () => executions,
    };
  }

  it('executes an approved model tool call after a crash between decision and execution', async () => {
    const tool = harnessTool();
    const { session, runStore, runState } = await setupDurableHarness();

    const ctx1 = await buildCtx({
      session,
      runStore,
      runState,
      toolExecutor: tool.executor,
    });
    await expect(
      ctx1.tool('destructive', { vendor: 'Northgate HVAC' }, {
        toolCallId: 'tc-model-1',
        def: tool.def,
      }),
    ).rejects.toThrow();

    const paused = await reloadRunState(runStore, runState.runId);
    const requestId = paused.waitingFor!.requestId;

    // The decision lands durably; the process dies before the operation executes.
    await recordSignalDelivery(runStore, paused, {
      signalId: 'sig-approve-crash-1',
      requestId,
      name: '__approval',
      actor: { id: 'property-manager', type: 'user' },
      decision: 'approve',
    });
    expect(tool.count()).toBe(0);

    // Process restarts. No signal delivery is resupplied — the resume call is long gone.
    // `resumePendingInterrupt` runs on every run open, so recovery must happen here.
    const resumed = await reloadRunState(runStore, runState.runId);
    const ctx2 = await buildCtx({
      session,
      runStore,
      runState: resumed,
      toolExecutor: tool.executor,
    });
    const outcome = await ctx2.resumePendingInterrupt(tool.def);

    expect(tool.count()).toBe(1);
    expect(outcome?.requestId).toBe(requestId);
    expect(outcome?.toolName).toBe('destructive');

    const steps = await runStore.getSteps(runState.runId);
    expect(steps.find((s) => s.kind === 'tool' && s.name === 'destructive')).toBeDefined();
    expect((await runStore.getRunState(runState.runId))?.waitingFor).toBeUndefined();
  });

  it('does not execute twice when recovery races a normal resume', async () => {
    const tool = harnessTool();
    const { session, runStore, runState } = await setupDurableHarness();

    const ctx1 = await buildCtx({
      session,
      runStore,
      runState,
      toolExecutor: tool.executor,
    });
    await expect(
      ctx1.tool('destructive', {}, { toolCallId: 'tc-model-2', def: tool.def }),
    ).rejects.toThrow();

    const paused = await reloadRunState(runStore, runState.runId);
    const requestId = paused.waitingFor!.requestId;

    const ctx2 = await buildCtx({
      session,
      runStore,
      runState: paused,
      toolExecutor: tool.executor,
      signalDelivery: {
        signalId: 'sig-approve-2',
        requestId,
        name: '__approval',
        actor: { id: 'property-manager', type: 'user' },
        decision: 'approve' as const,
      },
    });
    await ctx2.resumePendingInterrupt(tool.def);
    expect(tool.count()).toBe(1);

    // A later turn must not re-run the effect: the request is finished and cleared.
    const after = await reloadRunState(runStore, runState.runId);
    expect(after.waitingFor).toBeUndefined();
    const ctx3 = await buildCtx({
      session,
      runStore,
      runState: after,
      toolExecutor: tool.executor,
    });
    expect(await ctx3.resumePendingInterrupt(tool.def)).toBeUndefined();
    expect(tool.count()).toBe(1);
  });

  it('clears the request after a denial so the run does not stay pinned', async () => {
    const tool = harnessTool();
    const { session, runStore, runState } = await setupDurableHarness();

    const ctx1 = await buildCtx({
      session,
      runStore,
      runState,
      toolExecutor: tool.executor,
    });
    await expect(
      ctx1.tool('destructive', {}, { toolCallId: 'tc-model-3', def: tool.def }),
    ).rejects.toThrow();

    const paused = await reloadRunState(runStore, runState.runId);
    await recordSignalDelivery(runStore, paused, {
      signalId: 'sig-deny-3',
      requestId: paused.waitingFor!.requestId,
      name: '__approval',
      actor: { id: 'property-manager', type: 'user' },
      decision: 'deny',
    });

    const resumed = await reloadRunState(runStore, runState.runId);
    const ctx2 = await buildCtx({
      session,
      runStore,
      runState: resumed,
      toolExecutor: tool.executor,
    });
    await ctx2.resumePendingInterrupt(tool.def);

    expect(tool.count()).toBe(0);
    expect((await runStore.getRunState(runState.runId))?.waitingFor).toBeUndefined();
  });
});
