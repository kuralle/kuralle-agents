// FINDING 6 (FIXED): runEpoch scopes the effect-key namespace per logical run so a NEW user turn
// re-executes identical tool+args instead of replaying a prior turn's cached result.
import { describe, expect, it } from 'bun:test';
import { sessionDerivedRunId } from '../../src/runtime/openRun.js';
import { buildCtx, reloadRunState, setupDurableHarness } from '../core-durable/helpers.js';

describe('F6: cross-turn effect-key collision returns stale tool results', () => {
  it('runId is the sessionId verbatim — the durable run spans the whole session', () => {
    expect(sessionDerivedRunId('sess-abc')).toBe('sess-abc');
  });

  it('a genuinely new turn calling the same tool with the same args re-executes with fresh results', async () => {
    const balanceSpy = { count: 0, balance: 100 };
    const toolExecutor = {
      execute: async ({ name }: { name: string; args: unknown; session: unknown }) => {
        if (name !== 'get_balance') {
          throw new Error(`Unexpected tool: ${name}`);
        }
        balanceSpy.count += 1;
        // The real balance changes between the two turns.
        balanceSpy.balance -= 40;
        return { balance: balanceSpy.balance + 40 };
      },
    };

    // The session-lifetime run, exactly as openRun creates it (runId === sessionId).
    const { session, runStore, runState } = await setupDurableHarness('sess-1', 'sess-1');

    // Turn 1: user asks "what is my balance?" — model calls get_balance at ordinal 0.
    const turn1 = await buildCtx({ session, runStore, runState, toolExecutor });
    const first = await turn1.tool('get_balance', {});
    expect(first).toEqual({ balance: 100 });
    expect(balanceSpy.count).toBe(1);

    // Turn 5 (a NEW user request, hours later): Runtime builds a fresh RunContext
    // (effectOrdinal restarts at 0) over the SAME session-lifetime run and step log.
    const reloaded = await reloadRunState(runStore, runState.runId);
    const turn5 = await buildCtx({ session, runStore, runState: reloaded, toolExecutor });
    const second = await turn5.tool('get_balance', {});

    // runEpoch bumped on the fresh turn scopes the key namespace; prior-epoch steps are pruned.
    expect(balanceSpy.count).toBe(2);
    expect(second).toEqual({ balance: 60 });
    const steps = await runStore.getSteps(runState.runId);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.epoch).toBe(1);
    expect(steps[0]?.result).toEqual({ balance: 60 });
  });
});
