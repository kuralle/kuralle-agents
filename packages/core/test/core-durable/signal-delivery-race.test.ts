import { describe, expect, it } from 'bun:test';
import type { AnyTool } from '../../src/types/effectTool.js';
import { recordSignalDelivery } from '../../src/runtime/durable/replay.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { buildCtx, reloadRunState, setupDurableHarness, stubModel } from './helpers.js';

// Two people approve the same request at once, or a webhook retries in parallel. The
// store's append-time CAS already prevents a double decision and a double execution, but
// the loser used to surface an internal LogConflictError. Losing a race is the same
// outcome as delivering a duplicate signalId — already decided — and reports it the same
// way: `false`, not an exception the caller has to know to catch.
describe('concurrent signal delivery', () => {
  it('reports the loser of a decision race as already-decided, not as an error', async () => {
    const def = { name: 'destructive', needsApproval: true } as unknown as AnyTool;
    let executions = 0;
    const toolExecutor = {
      execute: async () => {
        executions += 1;
        return { dispatched: true };
      },
      getTool: () => def,
    };

    const { session, runStore, runState } = await setupDurableHarness();
    const ctx = await buildCtx({ session, runStore, runState, toolExecutor });
    await expect(
      ctx.tool('destructive', {}, { toolCallId: 'tc-race-1', def }),
    ).rejects.toThrow();

    const paused = await reloadRunState(runStore, runState.runId);
    const requestId = paused.waitingFor!.requestId;

    const deliver = (signalId: string, by: string) =>
      recordSignalDelivery(runStore, paused, {
        signalId,
        requestId,
        name: '__approval',
        actor: { id: by, type: 'user' as const },
        decision: 'approve' as const,
      });

    const settled = await Promise.allSettled([
      deliver('sig-a', 'manager-a'),
      deliver('sig-b', 'manager-b'),
    ]);

    // Neither call throws; exactly one records the decision.
    expect(settled.every((r) => r.status === 'fulfilled')).toBe(true);
    const outcomes = settled
      .filter((r): r is PromiseFulfilledResult<boolean> => r.status === 'fulfilled')
      .map((r) => r.value)
      .sort();
    expect(outcomes).toEqual([false, true]);

    const steps = await runStore.getSteps(runState.runId);
    const decisions = steps.filter((s) => s.interruptDecision?.requestId === requestId);
    expect(decisions).toHaveLength(1);
    expect(executions).toBe(0);
  });

  it('still surfaces a conflict that is not a duplicate decision', async () => {
    const { runStore, runState } = await setupDurableHarness();
    // No pending request at all: an unmatched delivery must still be rejected loudly
    // rather than swallowed as "someone else already decided".
    await expect(
      recordSignalDelivery(runStore, runState, {
        signalId: 'sig-orphan',
        requestId: 'req-does-not-exist',
        name: '__approval',
        actor: { id: 'manager', type: 'user' },
        decision: 'approve',
      }),
    ).rejects.toThrow();
  });

  it('rejects a signal-only Runtime turn when that scoped session has no pending interrupt', async () => {
    const runtime = createRuntime({
      agents: [defineAgent({
        id: 'agent-1',
        instructions: 'Test agent',
        model: stubModel,
      })],
      defaultAgentId: 'agent-1',
      defaultModel: stubModel,
      sessionStore: new MemoryStore(),
    });

    await expect(runtime.run({
      sessionId: 'different-shopper-session',
      signalDelivery: {
        signalId: 'sig-orphan-runtime',
        requestId: 'req-from-another-session',
        name: '__approval',
        actor: { id: 'shopper-b', type: 'user' },
        decision: 'approve',
      },
    })).rejects.toThrow('does not match waitingFor none');
  });
});
