import { describe, expect, it } from 'bun:test';
import type { EffectToolExecutor } from '../../src/types/run-context.js';
import { buildCtx, reloadRunState, setupDurableHarness } from './helpers.js';

describe('G9 parallel-safe durable tools', () => {
  it('fans out parallel-safe tools with non-colliding journal indices and deterministic replay', async () => {
    const spy = { a: 0, b: 0, c: 0 };

    const toolA = {
      name: 'lookup_a',
      description: 'Lookup A',
      parallelSafe: true as const,
      execute: async () => {
        spy.a += 1;
        return { a: spy.a };
      },
    };
    const toolB = {
      name: 'lookup_b',
      description: 'Lookup B',
      parallelSafe: true as const,
      execute: async () => {
        spy.b += 1;
        return { b: spy.b };
      },
    };
    const toolC = {
      name: 'lookup_c',
      description: 'Lookup C',
      parallelSafe: true as const,
      execute: async () => {
        spy.c += 1;
        return { c: spy.c };
      },
    };

    const toolExecutor: EffectToolExecutor = {
      getTool: (name: string) => {
        if (name === 'lookup_a') return toolA;
        if (name === 'lookup_b') return toolB;
        if (name === 'lookup_c') return toolC;
        return undefined;
      },
      execute: async (args) => {
        const resolved = args.def ?? toolExecutor.getTool?.(args.name);
        if (!resolved) throw new Error(`Unknown tool: ${args.name}`);
        return resolved.execute(args.args);
      },
    };

    const { session, runStore, runState } = await setupDurableHarness();

    async function parallelHandler(ctx: Awaited<ReturnType<typeof buildCtx>>) {
      const callsites = ctx.reserveCallsites(3);
      const steps = await ctx.runStore.getSteps(ctx.runState.runId);
      const finished = steps.filter((s) => s.status === 'finished' && s.name !== '__reserve');
      let indices: number[];
      if (finished.length >= 3) {
        indices = finished.slice(0, 3).map((s) => s.index);
      } else {
        indices = await ctx.runStore.reserveSteps!(ctx.runState.runId, 3);
      }
      const [ra, rb, rc] = await Promise.all([
        ctx.tool('lookup_a', {}, { def: toolA, callsite: callsites[0], index: indices[0] }),
        ctx.tool('lookup_b', {}, { def: toolB, callsite: callsites[1], index: indices[1] }),
        ctx.tool('lookup_c', {}, { def: toolC, callsite: callsites[2], index: indices[2] }),
      ]);
      return { ra, rb, rc };
    }

    const ctx1 = await buildCtx({ session, runStore, runState, toolExecutor });
    const live = await parallelHandler(ctx1);
    expect(live).toEqual({ ra: { a: 1 }, rb: { b: 1 }, rc: { c: 1 } });
    expect(spy).toEqual({ a: 1, b: 1, c: 1 });

    const stepsLive = await runStore.getSteps(runState.runId);
    expect(stepsLive).toHaveLength(3);
    expect(stepsLive.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(stepsLive.every((s) => s.status === 'finished')).toBe(true);
    const keys = stepsLive.map((s) => s.key);
    expect(new Set(keys).size).toBe(3);

    const reloaded = await reloadRunState(runStore, runState.runId);
    const ctx2 = await buildCtx({
      session,
      runStore,
      runState: reloaded,
      toolExecutor,
    });
    const replay = await parallelHandler(ctx2);
    expect(replay).toEqual(live);
    expect(spy).toEqual({ a: 1, b: 1, c: 1 });
    expect(await runStore.getSteps(runState.runId)).toHaveLength(3);
  });
});