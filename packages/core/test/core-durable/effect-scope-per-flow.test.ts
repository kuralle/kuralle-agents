import { describe, expect, it } from 'bun:test';
import type { AnyTool } from '../../src/types/effectTool.js';
import type { EffectToolExecutor } from '../../src/types/run-context.js';
import { buildCtx, setupDurableHarness } from './helpers.js';

// `resetCallsites()` rebases the durable effect ordinal to 0 on every flow entry, so a
// resumed run anchors its callsites to the flow rather than to whatever answering turn
// preceded it. But the effect key is (logicalRun, callsite, name, args) — with no flow in
// it. Two different flows in one logical run that call a same-named tool with the same
// arguments therefore collide on callsite 0, and the second one REPLAYS the first one's
// result instead of running.
//
// Live consequence (flows/llm-switching.ts): agent A's `switch_llm` returned "hand off to
// B"; after the handoff, agent B's own `switch_llm` replayed A's result and handed off to
// B again — six times, until maxHandoffs killed the run. The tool executed exactly once.
describe('durable effect scope', () => {
  function countingTool(): {
    def: AnyTool;
    executor: EffectToolExecutor;
    calls: () => string[];
    setOwner: (owner: string) => void;
  } {
    const calls: string[] = [];
    const def = { name: 'switch_llm' } as unknown as AnyTool;
    // Stands in for the per-flow closure the real example builds: each flow's tool knows
    // which flow it belongs to, so a replayed result is visibly the wrong flow's.
    let owner = 'unset';
    return {
      def,
      executor: {
        execute: async () => {
          calls.push(owner);
          return { owner };
        },
        getTool: () => def,
      } as unknown as EffectToolExecutor,
      calls: () => calls,
      setOwner: (next: string) => {
        owner = next;
      },
    };
  }

  it('does not replay one flow’s tool result into a different flow', async () => {
    const tool = countingTool();
    const { session, runStore, runState } = await setupDurableHarness();

    runState.activeFlow = 'flow-a';
    tool.setOwner('flow-a');
    const ctxA = await buildCtx({ session, runStore, runState, toolExecutor: tool.executor });
    ctxA.resetCallsites();
    const first = await ctxA.tool('switch_llm', { llm: 'Google' }, { def: tool.def });

    // A handoff inside the same turn: same run, same epoch, a different flow.
    const carried = (await runStore.getRunState(runState.runId))!;
    carried.activeFlow = 'flow-b';
    tool.setOwner('flow-b');
    await runStore.putRunState(carried);
    const ctxB = await buildCtx({
      session,
      runStore,
      runState: carried,
      toolExecutor: tool.executor,
    });
    ctxB.resetCallsites();
    const second = await ctxB.tool('switch_llm', { llm: 'Google' }, { def: tool.def });

    // Both flows ran their own call. Before the fix the second was a journal replay:
    // one execution, and `second` was flow-a's result.
    expect(tool.calls()).toEqual(['flow-a', 'flow-b']);
    expect(first).toEqual({ owner: 'flow-a' });
    expect(second).toEqual({ owner: 'flow-b' });
  });

  it('still replays within the same flow so resume stays exactly-once', async () => {
    const tool = countingTool();
    const { session, runStore, runState } = await setupDurableHarness();

    runState.activeFlow = 'flow-a';
    tool.setOwner('flow-a');
    const ctx1 = await buildCtx({ session, runStore, runState, toolExecutor: tool.executor });
    ctx1.resetCallsites();
    await ctx1.tool('switch_llm', { llm: 'Google' }, { def: tool.def });

    // Same flow re-entered on resume: the recorded step must be replayed, not re-run.
    const again = (await runStore.getRunState(runState.runId))!;
    const ctx2 = await buildCtx({
      session,
      runStore,
      runState: again,
      toolExecutor: tool.executor,
    });
    ctx2.resetCallsites();
    const replayed = await ctx2.tool('switch_llm', { llm: 'Google' }, { def: tool.def });

    expect(tool.calls()).toEqual(['flow-a']);
    expect(replayed).toEqual({ owner: 'flow-a' });
  });
});
