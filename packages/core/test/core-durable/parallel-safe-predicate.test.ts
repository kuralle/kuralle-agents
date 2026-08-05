import { describe, expect, it } from 'bun:test';
import type { EffectToolExecutor } from '../../src/types/run-context.js';
import { dispatchModelToolCalls } from '../../src/runtime/channels/executeModelTool.js';
import { buildCtx, setupDurableHarness } from './helpers.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `parallelSafe` is now a predicate over the RAW model args, not a static boolean, and
 * `replay: false` no longer implies parallel-safe. These three cases are the validation
 * contract for that change:
 *
 * (a) the SAME tool can be parallel for one call and serial for another in the same batch,
 * (b) a throwing predicate fails closed to serial instead of crashing the dispatcher,
 * (c) a `replay: false` tool with no `parallelSafe` is now scheduled serially — the
 *     regression this change closes. Restoring the old `|| replay === false` clause must
 *     make case (c) fail; that is how this test proves it discriminates.
 */
describe('parallelSafe as a predicate over raw args', () => {
  it('runs read-mode calls concurrently and forms a serial barrier at a write-mode call in the same batch', async () => {
    let inFlight = 0;
    const log: { event: 'start' | 'end'; id: string; inFlight: number }[] = [];

    const dualMode = {
      name: 'dual_mode',
      description: 'Parallel-safe only in read mode',
      parallelSafe: (args: { mode: 'read' | 'write' }) => args.mode === 'read',
      execute: async (args: { mode: 'read' | 'write'; id: string }) => {
        inFlight += 1;
        log.push({ event: 'start', id: args.id, inFlight });
        await sleep(15);
        inFlight -= 1;
        log.push({ event: 'end', id: args.id, inFlight });
        return { id: args.id };
      },
    };

    const toolExecutor: EffectToolExecutor = {
      getTool: () => dualMode,
      execute: async (args) => dualMode.execute(args.args as { mode: 'read' | 'write'; id: string }),
    };
    const { session, runStore, runState } = await setupDurableHarness();
    const ctx = await buildCtx({ session, runStore, runState, toolExecutor });

    const results: unknown[] = [];
    await dispatchModelToolCalls(
      ctx,
      [
        { toolName: 'dual_mode', input: { mode: 'read', id: 'r1' }, toolCallId: 'c1' },
        { toolName: 'dual_mode', input: { mode: 'read', id: 'r2' }, toolCallId: 'c2' },
        { toolName: 'dual_mode', input: { mode: 'write', id: 'w1' }, toolCallId: 'c3' },
        { toolName: 'dual_mode', input: { mode: 'read', id: 'r3' }, toolCallId: 'c4' },
      ],
      { dual_mode: dualMode },
      ({ outcome }) => results.push(outcome.result),
    );

    expect(results).toEqual([{ id: 'r1' }, { id: 'r2' }, { id: 'w1' }, { id: 'r3' }]);

    // The two reads genuinely overlapped: r2 started while r1 was still in flight.
    const r2Start = log.find((e) => e.event === 'start' && e.id === 'r2')!;
    expect(r2Start.inFlight).toBe(2);

    // The write formed a barrier: nothing else was in flight when it started, and it
    // started only after BOTH reads before it had finished.
    const r1End = log.findIndex((e) => e.event === 'end' && e.id === 'r1');
    const r2End = log.findIndex((e) => e.event === 'end' && e.id === 'r2');
    const w1Start = log.findIndex((e) => e.event === 'start' && e.id === 'w1');
    const w1End = log.findIndex((e) => e.event === 'end' && e.id === 'w1');
    const r3Start = log.findIndex((e) => e.event === 'start' && e.id === 'r3');
    expect(log[w1Start]!.inFlight).toBe(1);
    expect(w1Start).toBeGreaterThan(r1End);
    expect(w1Start).toBeGreaterThan(r2End);
    // The trailing read only starts its own new batch after the write barrier clears.
    expect(r3Start).toBeGreaterThan(w1End);
  });

  it('fails closed to serial, without crashing the dispatcher, when the predicate throws', async () => {
    let inFlight = 0;
    let sawOverlap = false;

    const flaky = {
      name: 'flaky_predicate',
      description: 'A parallelSafe predicate that always throws',
      parallelSafe: () => {
        throw new Error('predicate boom');
      },
      execute: async () => {
        inFlight += 1;
        if (inFlight > 1) sawOverlap = true;
        await sleep(10);
        inFlight -= 1;
        return { ok: true };
      },
    };

    const toolExecutor: EffectToolExecutor = {
      getTool: () => flaky,
      execute: async () => flaky.execute(),
    };
    const { session, runStore, runState } = await setupDurableHarness();
    const ctx = await buildCtx({ session, runStore, runState, toolExecutor });

    const outcomes: { result: unknown; failed: boolean }[] = [];
    await expect(
      dispatchModelToolCalls(
        ctx,
        [
          { toolName: 'flaky_predicate', input: {}, toolCallId: 'c1' },
          { toolName: 'flaky_predicate', input: {}, toolCallId: 'c2' },
        ],
        { flaky_predicate: flaky },
        ({ outcome }) => outcomes.push({ result: outcome.result, failed: outcome.failed }),
      ),
    ).resolves.toBeUndefined();

    expect(sawOverlap).toBe(false);
    expect(outcomes).toEqual([
      { result: { ok: true }, failed: false },
      { result: { ok: true }, failed: false },
    ]);
  });

  it('regression: a replay:false tool with no parallelSafe is scheduled SERIALLY, not implied parallel', async () => {
    let inFlight = 0;
    let sawOverlap = false;

    const readOnly = {
      name: 'read_only',
      description: 'replay:false, no parallelSafe',
      replay: false as const,
      execute: async () => {
        inFlight += 1;
        if (inFlight > 1) sawOverlap = true;
        await sleep(10);
        inFlight -= 1;
        return { ok: true };
      },
    };

    const toolExecutor: EffectToolExecutor = {
      getTool: () => readOnly,
      execute: async () => readOnly.execute(),
    };
    const { session, runStore, runState } = await setupDurableHarness();
    const ctx = await buildCtx({ session, runStore, runState, toolExecutor });

    await dispatchModelToolCalls(
      ctx,
      [
        { toolName: 'read_only', input: {}, toolCallId: 'c1' },
        { toolName: 'read_only', input: {}, toolCallId: 'c2' },
      ],
      { read_only: readOnly },
      () => {},
    );

    // Before this change, `replay: false` alone implied parallel-safe and these two
    // calls would have overlapped. Restoring `|| def?.replay === false` in
    // `isParallelSafeTool` must turn this assertion false, which is how this test
    // proves it discriminates.
    expect(sawOverlap).toBe(false);
  });
});
