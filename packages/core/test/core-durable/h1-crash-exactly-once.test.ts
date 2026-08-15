import { describe, expect, it } from 'bun:test';
import type { EffectToolExecutor } from '../../src/types/run-context.js';
import type { DeleteRunOptions, RunStore, StepFinalizePatch } from '../../src/runtime/durable/RunStore.js';
import type { RunFilter, RunState, StepRecord } from '../../src/runtime/durable/types.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { buildCtx, reloadRunState, setupDurableHarness } from './helpers.js';

/** Simulates a crash after execute() but before finalize persists the result. */
class CrashOnFinalizeStore implements RunStore {
  readonly inner: SessionRunStore;
  private crashed = false;

  constructor(inner: SessionRunStore) {
    this.inner = inner;
  }

  appendStep(runId: string, record: StepRecord): Promise<void> {
    return this.inner.appendStep(runId, record);
  }

  async finalizeStep(runId: string, key: string, patch: StepFinalizePatch): Promise<void> {
    if (!this.crashed) {
      this.crashed = true;
      throw new Error('simulated crash before finalize');
    }
    return this.inner.finalizeStep(runId, key, patch);
  }

  getSteps(runId: string): Promise<StepRecord[]> {
    return this.inner.getSteps(runId);
  }

  getRunState(runId: string): Promise<RunState | null> {
    return this.inner.getRunState(runId);
  }

  putRunState(state: RunState): Promise<void> {
    return this.inner.putRunState(state);
  }

  listRuns(filter: RunFilter) {
    return this.inner.listRuns(filter);
  }

  deleteRun(runId: string, options?: DeleteRunOptions): Promise<void> {
    return this.inner.deleteRun(runId, options);
  }

  initRun(state: RunState): Promise<void> {
    return this.inner.initRun(state);
  }

  pruneStepsBeforeEpoch(runId: string, keepEpoch: number): Promise<void> {
    return this.inner.pruneStepsBeforeEpoch(runId, keepEpoch);
  }
}

describe('H1 intent-before-execute', () => {
  it('records pending intent before execute; crash-before-finalize leaves running step', async () => {
    const chargeSpy = { count: 0 };
    const sideEffectSpy = { count: 0 };
    const dedupKeys = new Set<string>();

    const toolDef = {
      name: 'charge',
      description: 'Charge card',
      replay: true as const,
      idempotencyKey: (args: { amount: number }) => `charge:${args.amount}`,
      execute: async (args: { amount: number }) => {
        chargeSpy.count += 1;
        const key = `charge:${args.amount}`;
        if (dedupKeys.has(key)) {
          return { charged: true, amount: args.amount, deduped: true };
        }
        dedupKeys.add(key);
        sideEffectSpy.count += 1;
        return { charged: true, amount: args.amount };
      },
    };

    const toolExecutor: EffectToolExecutor = {
      getTool: (name: string) => (name === 'charge' ? toolDef : undefined),
      execute: async (args) => {
        const resolved = args.def ?? toolDef;
        return resolved.execute(args.args as { amount: number });
      },
    };

    const { session, memoryStore, runState } = await setupDurableHarness();
    const inner = new SessionRunStore(memoryStore, session.id);
    const crashStore = new CrashOnFinalizeStore(inner);

    async function chargeHandler(ctx: Awaited<ReturnType<typeof buildCtx>>) {
      return ctx.tool('charge', { amount: 100 }, { def: toolDef });
    }

    const ctx1 = await buildCtx({
      session,
      runStore: crashStore,
      runState,
      toolExecutor,
    });

    await expect(chargeHandler(ctx1)).rejects.toThrow('simulated crash before finalize');
    expect(chargeSpy.count).toBe(1);
    expect(sideEffectSpy.count).toBe(1);

    const stepsMidCrash = await inner.getSteps(runState.runId);
    expect(stepsMidCrash).toHaveLength(1);
    expect(stepsMidCrash[0]?.status).toBe('running');
    expect(stepsMidCrash[0]?.result).toBeUndefined();

    const reloaded = await reloadRunState(inner, runState.runId);
    const ctx2 = await buildCtx({
      session,
      runStore: inner,
      runState: reloaded,
      toolExecutor,
    });

    const result = await chargeHandler(ctx2);
    expect(result).toMatchObject({ charged: true, amount: 100 });
    expect(chargeSpy.count).toBe(2);
    expect(sideEffectSpy.count).toBe(1);

    const stepsFinal = await inner.getSteps(runState.runId);
    expect(stepsFinal).toHaveLength(1);
    expect(stepsFinal[0]?.status).toBe('finished');
    expect(stepsFinal[0]?.result).toMatchObject({ charged: true, amount: 100 });
  });

  it('finished step replays without re-executing execute()', async () => {
    const chargeSpy = { count: 0 };
    const toolDef = {
      name: 'charge',
      description: 'Charge card',
      replay: true as const,
      execute: async (args: { amount: number }) => {
        chargeSpy.count += 1;
        return { charged: true, amount: args.amount };
      },
    };

    const toolExecutor: EffectToolExecutor = {
      getTool: (name: string) => (name === 'charge' ? toolDef : undefined),
      execute: async (args) => toolDef.execute(args.args as { amount: number }),
    };

    const { session, runStore, runState } = await setupDurableHarness();

    async function chargeHandler(ctx: Awaited<ReturnType<typeof buildCtx>>) {
      return ctx.tool('charge', { amount: 50 }, { def: toolDef });
    }

    const ctx1 = await buildCtx({ session, runStore, runState, toolExecutor });
    await chargeHandler(ctx1);
    expect(chargeSpy.count).toBe(1);

    const steps = await runStore.getSteps(runState.runId);
    expect(steps[0]?.status).toBe('finished');

    const reloaded = await reloadRunState(runStore, runState.runId);
    const ctx2 = await buildCtx({
      session,
      runStore,
      runState: reloaded,
      toolExecutor,
    });
    await chargeHandler(ctx2);
    expect(chargeSpy.count).toBe(1);
  });

  it('uses per-tool idempotencyKey override when provided', async () => {
    const keys = new Set<string>();
    const toolDef = {
      name: 'pay',
      description: 'Pay invoice',
      replay: true as const,
      idempotencyKey: () => 'stable-pay-key',
      execute: async () => ({ ok: true }),
    };

    const toolExecutor: EffectToolExecutor = {
      getTool: (name: string) => (name === 'pay' ? toolDef : undefined),
      execute: async () => toolDef.execute(),
    };

    const { session, runStore, runState } = await setupDurableHarness();
    const ctx = await buildCtx({ session, runStore, runState, toolExecutor });
    await ctx.tool('pay', { nonce: 'abc' }, { def: toolDef });

    const steps = await runStore.getSteps(runState.runId);
    expect(steps).toHaveLength(1);
    keys.add(steps[0]!.key);

    const reloaded = await reloadRunState(runStore, runState.runId);
    const ctx2 = await buildCtx({
      session,
      runStore,
      runState: reloaded,
      toolExecutor,
    });
    await ctx2.tool('pay', { nonce: 'different' }, { def: toolDef });

    const stepsAfter = await runStore.getSteps(runState.runId);
    expect(stepsAfter).toHaveLength(1);
    expect(stepsAfter[0]?.key).toBe(steps[0]?.key);
  });
});