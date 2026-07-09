import { describe, expect, it } from 'bun:test';
import type { StepRecord } from '../../src/runtime/durable/types.js';
import { LogConflictError } from '../../src/runtime/durable/RunStore.js';
import { buildCtx, setupDurableHarness } from './helpers.js';

describe('core-v2 durable replay determinism', () => {
  it('ctx.now and ctx.uuid return recorded values on replay', async () => {
    let nowCalls = 0;
    let uuidCalls = 0;
    const clock = {
      now: () => {
        nowCalls += 1;
        return 1_700_000_000_123;
      },
      uuid: () => {
        uuidCalls += 1;
        return 'uuid-live-1';
      },
    };

    const toolExecutor = { execute: async () => ({}) };
    const { session, runStore, runState } = await setupDurableHarness();

    async function clockHandler(ctx: Awaited<ReturnType<typeof buildCtx>>) {
      const now = await ctx.now();
      const id = await ctx.uuid();
      return { now, id };
    }

    const ctx1 = await buildCtx({ session, runStore, runState, toolExecutor, clock });
    const live = await clockHandler(ctx1);
    expect(live).toEqual({ now: 1_700_000_000_123, id: 'uuid-live-1' });
    expect(nowCalls).toBe(1);
    expect(uuidCalls).toBe(1);

    const reloaded = (await runStore.getRunState(runState.runId))!;
    const ctx2 = await buildCtx({ session, runStore, runState: reloaded, toolExecutor, clock });
    const replay = await clockHandler(ctx2);

    expect(replay).toEqual(live);
    expect(nowCalls).toBe(1);
    expect(uuidCalls).toBe(1);

    const steps = await runStore.getSteps(runState.runId);
    expect(steps.map((step) => step.kind)).toEqual(['now', 'uuid']);
    expect(steps[0]?.result).toBe(1_700_000_000_123);
    expect(steps[1]?.result).toBe('uuid-live-1');
  });
});

describe('core-v2 durable CAS conflict', () => {
  it('appendStep throws LogConflictError on concurrent index collision', async () => {
    const { runStore, runState } = await setupDurableHarness();

    const record: StepRecord = {
      index: 0,
      key: 'key-a',
      kind: 'now',
      name: 'now',
      result: 123,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    };

    await runStore.appendStep(runState.runId, record);

    const conflicting: StepRecord = {
      ...record,
      key: 'key-b',
    };

    await expect(runStore.appendStep(runState.runId, conflicting)).rejects.toBeInstanceOf(
      LogConflictError,
    );
  });
});
