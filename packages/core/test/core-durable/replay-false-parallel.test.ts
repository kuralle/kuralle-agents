import { describe, expect, it } from 'bun:test';
import { CoreToolExecutor } from '../../src/tools/effect/ToolExecutor.js';
import { dispatchModelToolCalls } from '../../src/runtime/channels/executeModelTool.js';
import { buildCtx, setupDurableHarness } from './helpers.js';

/**
 * `replay: false` tools derive their journal key from `steps.length` at call time
 * (`ctx.ts` — `${key}:${steps.length}:${callsite}`). When several run in parallel — which
 * `parallelSafe: true` read tools do by design — each reads that length before any of them
 * has appended, so the key a call finalizes under can disagree with the key it appended
 * under, and `finalizeStep` throws `StepNotFoundError`.
 *
 * Observed in a live agent as:
 *   error: Step not found for run realm: eb5da9f4…:1:1
 */
describe('replay:false tools under parallel dispatch', () => {
  it('does not lose a step key when several run concurrently', async () => {
    const harness = await setupDurableHarness('rf-sess', 'rf-run');
    const calls = { a: 0, b: 0, c: 0 };
    const mk = (k: keyof typeof calls) => ({
      name: `read_${k}`,
      description: `Read ${k}`,
      replay: false as const,
      parallelSafe: true as const,
      execute: async () => {
        calls[k] += 1;
        // Yield so the parallel calls genuinely interleave rather than running to
        // completion one at a time.
        await new Promise((r) => setTimeout(r, 5));
        return { [k]: true };
      },
    });
    const seed = {
      name: 'seed', description: 'Seed journal depth',
      replay: false as const,
      execute: async () => ({ ok: true }),
    };
    const tools = { read_a: mk('a'), read_b: mk('b'), read_c: mk('c'), seed };

    const ctx = await buildCtx({ ...harness, toolExecutor: new CoreToolExecutor({ tools }) });

    // Build journal depth FIRST. The live failure had ten prior steps, and the two parallel
    // calls were assigned indices 10 and 11 while `steps.length` was still 10 — so the
    // batch must not start from an empty journal or the race never appears.
    for (let i = 0; i < 4; i += 1) {
      await ctx.tool('seed', { i });
    }

    const errors: unknown[] = [];
    const results: unknown[] = [];
    await dispatchModelToolCalls(
      ctx,
      [
        { toolName: 'read_a', input: {}, toolCallId: 'c1' },
        { toolName: 'read_b', input: {}, toolCallId: 'c2' },
        { toolName: 'read_c', input: {}, toolCallId: 'c3' },
      ],
      tools,
      ({ outcome }) => {
        results.push(outcome.result);
        if (outcome.failed) errors.push(outcome.result);
      },
    );

    expect(errors).toEqual([]);
    expect(results).toHaveLength(3);
    expect(calls).toEqual({ a: 1, b: 1, c: 1 });

    // Every appended step must have been finalized — a step left `running` is the
    // signature of a finalize that went to the wrong key.
    const steps = await harness.runStore.getSteps('rf-run');
    const unfinished = steps.filter((s) => s.status === 'running' && !s.key.startsWith('__reserve'));
    expect(unfinished).toEqual([]);
  });
});
