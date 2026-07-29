import { describe, expect, it } from 'bun:test';
import { recordSignalDelivery } from '../../src/runtime/durable/replay.js';
import { reloadRunState, setupDurableHarness } from './helpers.js';
import type { AnyTool } from '../../src/types/effectTool.js';
import { buildCtx } from './helpers.js';

// `resumeKey` binds a decision to the exact pause that requested it. It is required on
// every request this version creates, but a run that was ALREADY paused when the upgrade
// landed — sitting in Redis or Postgres awaiting a human — has no such field. Silently
// falling back to the old positional derivation would key that decision by call order,
// which is the property the interrupt-identity work exists to remove. Fail closed and say
// so, rather than quietly resurrect positional identity on a durable store.
describe('resumeKey migration', () => {
  it('refuses a delivery for a pre-upgrade request that has no resumeKey', async () => {
    const def = { name: 'destructive', needsApproval: true } as unknown as AnyTool;
    const toolExecutor = {
      execute: async () => ({ dispatched: true }),
      getTool: () => def,
    };
    const { session, runStore, runState } = await setupDurableHarness();
    const ctx = await buildCtx({ session, runStore, runState, toolExecutor });
    await expect(
      ctx.tool('destructive', {}, { toolCallId: 'tc-legacy', def }),
    ).rejects.toThrow();

    const paused = await reloadRunState(runStore, runState.runId);
    const requestId = paused.waitingFor!.requestId;
    // Model the legacy shape: the field simply is not there.
    delete (paused.waitingFor as unknown as { resumeKey?: string }).resumeKey;

    await expect(
      recordSignalDelivery(runStore, paused, {
        signalId: 'sig-legacy',
        requestId,
        name: '__approval',
        actor: { id: 'manager', type: 'user' },
        decision: 'approve',
      }),
    ).rejects.toThrow(/resumeKey/);
  });

  it('accepts a delivery for a request created by this version', async () => {
    const def = { name: 'destructive', needsApproval: true } as unknown as AnyTool;
    const toolExecutor = {
      execute: async () => ({ dispatched: true }),
      getTool: () => def,
    };
    const { session, runStore, runState } = await setupDurableHarness();
    const ctx = await buildCtx({ session, runStore, runState, toolExecutor });
    await expect(
      ctx.tool('destructive', {}, { toolCallId: 'tc-current', def }),
    ).rejects.toThrow();

    const paused = await reloadRunState(runStore, runState.runId);
    expect(paused.waitingFor?.resumeKey).toBeTruthy();
    await expect(
      recordSignalDelivery(runStore, paused, {
        signalId: 'sig-current',
        requestId: paused.waitingFor!.requestId,
        name: '__approval',
        actor: { id: 'manager', type: 'user' },
        decision: 'approve',
      }),
    ).resolves.toBe(true);
  });
});
