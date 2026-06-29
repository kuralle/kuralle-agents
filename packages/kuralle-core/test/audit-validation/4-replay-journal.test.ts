// FINDING 4: Durable runtime replay misses journal when callsite ordinal shifts | anchor src/runtime/ctx.ts:99-133, :219-221 | why this proves it
import { describe, expect, it } from 'bun:test';
import { buildCtx, reloadRunState, setupDurableHarness } from '../core-durable/helpers.js';

describe('F4: durable journal replay with shifted callsite ordinal', () => {
  it('preceding effect on replay shifts ordinal and re-executes the tool', async () => {
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

    async function chargeOnly(ctx: Awaited<ReturnType<typeof buildCtx>>) {
      return ctx.tool('charge', { amount: 100 });
    }

    const ctx1 = await buildCtx({ session, runStore, runState, toolExecutor });
    const firstResult = await chargeOnly(ctx1);
    expect(firstResult).toEqual({ charged: true, amount: 100 });
    expect(chargeSpy.count).toBe(1);

    const stepsAfterRecord = await runStore.getSteps(runState.runId);
    expect(stepsAfterRecord).toHaveLength(1);
    expect(stepsAfterRecord[0]?.kind).toBe('tool');

    async function nowThenCharge(ctx: Awaited<ReturnType<typeof buildCtx>>) {
      await ctx.now();
      return ctx.tool('charge', { amount: 100 });
    }

    const reloaded = await reloadRunState(runStore, runState.runId);
    const ctx2 = await buildCtx({ session, runStore, runState: reloaded, toolExecutor });
    const replayResult = await nowThenCharge(ctx2);

    expect(replayResult).toEqual({ charged: true, amount: 100 });
    expect(chargeSpy.count).toBe(2);

    const stepsAfterShiftedReplay = await runStore.getSteps(runState.runId);
    expect(stepsAfterShiftedReplay.length).toBeGreaterThan(1);
    const toolSteps = stepsAfterShiftedReplay.filter((step) => step.kind === 'tool');
    expect(toolSteps.length).toBe(2);
  });

  it('identical handler replay resolves journal without re-executing', async () => {
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

    async function chargeOnly(ctx: Awaited<ReturnType<typeof buildCtx>>) {
      return ctx.tool('charge', { amount: 100 });
    }

    const ctx1 = await buildCtx({ session, runStore, runState, toolExecutor });
    await chargeOnly(ctx1);
    expect(chargeSpy.count).toBe(1);

    const reloaded = await reloadRunState(runStore, runState.runId);
    const ctx2 = await buildCtx({ session, runStore, runState: reloaded, toolExecutor });
    await chargeOnly(ctx2);

    expect(chargeSpy.count).toBe(1);
    expect(await runStore.getSteps(runState.runId)).toHaveLength(1);
  });
});