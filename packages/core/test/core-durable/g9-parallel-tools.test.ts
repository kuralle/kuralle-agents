import { describe, expect, it } from 'bun:test';
import type { RunStore } from '../../src/runtime/durable/RunStore.js';
import type { EffectToolExecutor } from '../../src/types/run-context.js';
import {
  dispatchModelToolCalls,
  executeModelToolCall,
} from '../../src/runtime/channels/executeModelTool.js';
import { buildCtx, reloadRunState, setupDurableHarness } from './helpers.js';

function withoutReserveSteps(store: RunStore): RunStore {
  return {
    appendStep: store.appendStep.bind(store),
    finalizeStep: store.finalizeStep.bind(store),
    getSteps: store.getSteps.bind(store),
    getRunState: store.getRunState.bind(store),
    putRunState: store.putRunState.bind(store),
  };
}

describe('G9 parallel-safe durable tools', () => {
  it('atomically assigns ordinals to user-authored parallel ctx.tool calls', async () => {
    const spy = { a: 0, b: 0, c: 0 };
    const tools = {
      parallel_a: {
        name: 'parallel_a',
        description: 'Parallel A',
        execute: async () => {
          spy.a += 1;
          return { a: spy.a };
        },
      },
      parallel_b: {
        name: 'parallel_b',
        description: 'Parallel B',
        execute: async () => {
          spy.b += 1;
          return { b: spy.b };
        },
      },
      parallel_c: {
        name: 'parallel_c',
        description: 'Parallel C',
        execute: async () => {
          spy.c += 1;
          return { c: spy.c };
        },
      },
    };

    const toolExecutor: EffectToolExecutor = {
      getTool: (name) => tools[name as keyof typeof tools],
      execute: async (args) => {
        const def = tools[args.name as keyof typeof tools];
        if (!def) throw new Error(`Unknown tool: ${args.name}`);
        return def.execute();
      },
    };
    const { session, runStore, runState } = await setupDurableHarness();
    const ctx = await buildCtx({ session, runStore, runState, toolExecutor });

    const result = await Promise.all([
      ctx.tool('parallel_a', {}),
      ctx.tool('parallel_b', {}),
      ctx.tool('parallel_c', {}),
    ]);

    expect(result).toEqual([{ a: 1 }, { b: 1 }, { c: 1 }]);
    expect(spy).toEqual({ a: 1, b: 1, c: 1 });

    const steps = await runStore.getSteps(runState.runId);
    expect(steps).toHaveLength(3);
    expect(steps.map((step) => step.index)).toEqual([0, 1, 2]);
    expect(new Set(steps.map((step) => step.name))).toEqual(
      new Set(['parallel_a', 'parallel_b', 'parallel_c']),
    );
    expect(steps.every((step) => step.status === 'finished')).toBe(true);

    const replayCtx = await buildCtx({ session, runStore, runState, toolExecutor });
    await expect(
      Promise.all([
        replayCtx.tool('parallel_a', {}),
        replayCtx.tool('parallel_b', {}),
        replayCtx.tool('parallel_c', {}),
      ]),
    ).resolves.toEqual(result);
    expect(spy).toEqual({ a: 1, b: 1, c: 1 });
    expect(await runStore.getSteps(runState.runId)).toHaveLength(3);
  });

  it('serializes ordinals for a legacy store without reserveSteps', async () => {
    const executed: string[] = [];
    const tools = {
      legacy_a: {
        name: 'legacy_a',
        description: 'Legacy A',
        execute: async () => {
          executed.push('legacy_a');
          return 'a';
        },
      },
      legacy_b: {
        name: 'legacy_b',
        description: 'Legacy B',
        execute: async () => {
          executed.push('legacy_b');
          return 'b';
        },
      },
      legacy_c: {
        name: 'legacy_c',
        description: 'Legacy C',
        execute: async () => {
          executed.push('legacy_c');
          return 'c';
        },
      },
    };
    const toolExecutor: EffectToolExecutor = {
      getTool: (name) => tools[name as keyof typeof tools],
      execute: async (args) => tools[args.name as keyof typeof tools]!.execute(),
    };
    const { session, runStore, runState } = await setupDurableHarness();
    const legacyStore = withoutReserveSteps(runStore);
    const ctx = await buildCtx({
      session,
      runStore: legacyStore,
      runState,
      toolExecutor,
    });

    await expect(
      Promise.all([
        ctx.tool('legacy_a', {}),
        ctx.tool('legacy_b', {}),
        ctx.tool('legacy_c', {}),
      ]),
    ).resolves.toEqual(['a', 'b', 'c']);
    expect(executed).toHaveLength(3);
    expect((await legacyStore.getSteps(runState.runId)).map((step) => step.index)).toEqual([
      0,
      1,
      2,
    ]);
  });

  it('contains throwing model tools as typed failures for Promise.all', async () => {
    const throwingTool = {
      name: 'throwing_tool',
      description: 'Throws',
      execute: async () => {
        throw new Error('tool exploded');
      },
    };
    const toolExecutor: EffectToolExecutor = {
      getTool: () => throwingTool,
      execute: async () => {
        throw new Error('tool exploded');
      },
    };
    const { session, runStore, runState } = await setupDurableHarness();
    const ctx = await buildCtx({ session, runStore, runState, toolExecutor });

    await expect(
      executeModelToolCall(
        ctx,
        { toolName: 'throwing_tool', input: {}, toolCallId: 'call-throwing' },
        { throwing_tool: throwingTool },
      ),
    ).resolves.toMatchObject({ failed: true });
  });

  it('does not move parallel-safe calls across an exclusive call in the same model batch', async () => {
    const executionOrder: string[] = [];
    const tools = {
      parallel_before: {
        name: 'parallel_before',
        description: 'Parallel lookup before the exclusive effect',
        parallelSafe: true as const,
        execute: async () => {
          executionOrder.push('parallel_before');
          return { ok: true };
        },
      },
      exclusive: {
        name: 'exclusive',
        description: 'Exclusive effect',
        execute: async () => {
          executionOrder.push('exclusive');
          return { ok: true };
        },
      },
      parallel_after: {
        name: 'parallel_after',
        description: 'Parallel lookup after the exclusive effect',
        parallelSafe: true as const,
        execute: async () => {
          executionOrder.push('parallel_after');
          return { ok: true };
        },
      },
    };

    const toolExecutor: EffectToolExecutor = {
      getTool: (name) => tools[name as keyof typeof tools],
      execute: async (args) => {
        const def = tools[args.name as keyof typeof tools];
        if (!def) throw new Error(`Unknown tool: ${args.name}`);
        return def.execute();
      },
    };
    const { session, runStore, runState } = await setupDurableHarness();
    const ctx = await buildCtx({ session, runStore, runState, toolExecutor });

    await dispatchModelToolCalls(
      ctx,
      [
        { toolName: 'parallel_before', input: {}, toolCallId: 'call-1' },
        { toolName: 'exclusive', input: {}, toolCallId: 'call-2' },
        { toolName: 'parallel_after', input: {}, toolCallId: 'call-3' },
      ],
      tools,
      () => {},
    );

    expect(executionOrder).toEqual(['parallel_before', 'exclusive', 'parallel_after']);
    expect((await runStore.getSteps(runState.runId)).map((step) => step.name)).toEqual([
      'parallel_before',
      'exclusive',
      'parallel_after',
    ]);
  });

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
