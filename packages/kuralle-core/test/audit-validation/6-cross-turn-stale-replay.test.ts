// FINDING 6: runId === sessionId and callsite ordinals reset per turn, so a NEW user turn re-issuing the same tool+args replays the first turn's cached result instead of executing | anchor src/runtime/openRun.ts:37-39, src/runtime/ctx.ts:60-73,219-221 | proves "exactly-once" is actually "once-ever-per-session" for stable-arg tools
import { describe, expect, it } from 'bun:test';
import { sessionDerivedRunId } from '../../src/runtime/openRun.js';
import { buildCtx, reloadRunState, setupDurableHarness } from '../core-durable/helpers.js';

describe('F6: cross-turn effect-key collision returns stale tool results', () => {
  it('runId is the sessionId verbatim — the durable run spans the whole session', () => {
    expect(sessionDerivedRunId('sess-abc')).toBe('sess-abc');
  });

  it('a genuinely new turn calling the same tool with the same args never executes it again', async () => {
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

    // CURRENT behavior: the key hash(runId, callsite=0, name, args) collides with
    // turn 1's step, so the executor never runs and the user is told a stale balance.
    expect(balanceSpy.count).toBe(1);
    expect(second).toEqual({ balance: 100 });
    expect(await runStore.getSteps(runState.runId)).toHaveLength(1);
  });
});
