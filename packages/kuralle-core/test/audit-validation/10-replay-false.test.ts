import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { buildCtx, reloadRunState, setupDurableHarness } from '../core-durable/helpers.js';

describe('replay:false durable journal bypass', () => {
  it('replay:false tool executes twice with identical args on replay', async () => {
    const observeSpy = { count: 0 };
    const observe = defineTool({
      name: 'observe',
      description: 'Observe fresh state',
      replay: false,
      input: z.object({ path: z.string() }),
      execute: async () => {
        observeSpy.count += 1;
        return { seen: observeSpy.count };
      },
    });

    const executor = new CoreToolExecutor({ tools: { observe } });
    const { session, runStore, runState } = await setupDurableHarness('replay-false-sess', 'replay-false-run');

    async function observeOnly(ctx: Awaited<ReturnType<typeof buildCtx>>) {
      return ctx.tool('observe', { path: '/tmp/x' });
    }

    const ctx1 = await buildCtx({ session, runStore, runState, toolExecutor: executor });
    const first = await observeOnly(ctx1);
    expect(first).toEqual({ seen: 1 });
    expect(observeSpy.count).toBe(1);

    const reloaded = await reloadRunState(runStore, runState.runId);
    const ctx2 = await buildCtx({ session, runStore, runState: reloaded, toolExecutor: executor });
    const second = await observeOnly(ctx2);
    expect(second).toEqual({ seen: 2 });
    expect(observeSpy.count).toBe(2);
  });

  it('default replay:true tool executes once with identical args on replay', async () => {
    const chargeSpy = { count: 0 };
    const charge = defineTool({
      name: 'charge',
      description: 'Charge the customer',
      input: z.object({ amount: z.number() }),
      execute: async () => {
        chargeSpy.count += 1;
        return { charged: true, amount: 100 };
      },
    });

    const executor = new CoreToolExecutor({ tools: { charge } });
    const { session, runStore, runState } = await setupDurableHarness('replay-true-sess', 'replay-true-run');

    async function chargeOnly(ctx: Awaited<ReturnType<typeof buildCtx>>) {
      return ctx.tool('charge', { amount: 100 });
    }

    const ctx1 = await buildCtx({ session, runStore, runState, toolExecutor: executor });
    await chargeOnly(ctx1);
    expect(chargeSpy.count).toBe(1);

    const reloaded = await reloadRunState(runStore, runState.runId);
    const ctx2 = await buildCtx({ session, runStore, runState: reloaded, toolExecutor: executor });
    await chargeOnly(ctx2);
    expect(chargeSpy.count).toBe(1);
  });
});