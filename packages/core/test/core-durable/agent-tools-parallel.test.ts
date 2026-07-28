import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { dispatchModelToolCalls } from '../../src/runtime/channels/executeModelTool.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import { buildCtx, setupDurableHarness } from './helpers.js';
import type { EffectToolExecutor } from '../../src/types/run-context.js';

describe('agent.tools parallel dispatch', () => {
  it('dispatches parallelSafe agent.tools concurrently when not in mergedTools', async () => {
    const barrier = { reached: 0, release: () => {} };
    const gate = new Promise<void>((resolve) => {
      barrier.release = resolve;
    });

    const parallelAgentTool = defineTool({
      name: 'agent_parallel',
      description: 'Parallel agent tool',
      input: z.object({}),
      parallelSafe: true as const,
      execute: async () => {
        barrier.reached += 1;
        if (barrier.reached === 1) {
          await gate;
        }
        return { ok: true };
      },
    });

    const toolExecutor: EffectToolExecutor = {
      getTool: (name) => (name === 'agent_parallel' ? parallelAgentTool : undefined),
      execute: async (args) => parallelAgentTool.execute(args.args as Record<string, never>),
    };

    const { session, runStore, runState } = await setupDurableHarness('agent-par', 'agent-par');
    const ctx = await buildCtx({ session, runStore, runState, toolExecutor });

    const calls = [
      { toolName: 'agent_parallel', input: {}, toolCallId: 'c1' },
      { toolName: 'agent_parallel', input: {}, toolCallId: 'c2' },
    ];

    let bothStarted = false;
    const dispatchPromise = dispatchModelToolCalls(ctx, calls, {}, () => {});

    await new Promise((r) => setTimeout(r, 20));
    expect(barrier.reached).toBe(2);
    bothStarted = barrier.reached === 2;
    barrier.release();
    await dispatchPromise;

    expect(bothStarted).toBe(true);
  });
});
