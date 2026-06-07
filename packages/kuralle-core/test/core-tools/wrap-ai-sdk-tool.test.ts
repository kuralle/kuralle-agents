import { describe, expect, it } from 'bun:test';
import { tool as aiTool } from 'ai';
import { z } from 'zod';
import { wrapAiSdkTool } from '../../src/tools/effect/wrapAiSdkTool.js';
import { CoreToolExecutor } from '../../src/tools/effect/ToolExecutor.js';
import { buildCtx, reloadRunState, setupDurableHarness } from '../core-durable/helpers.js';

describe('test:wrap-ai-sdk-tool', () => {
  it('wraps an AI SDK tool and runs it through the durable journal', async () => {
    const execSpy = { count: 0 };
    const rawAiTool = aiTool({
      description: 'Double a number',
      inputSchema: z.object({ x: z.number() }),
      execute: async ({ x }) => {
        execSpy.count += 1;
        return { doubled: x * 2 };
      },
    });

    const wrapped = wrapAiSdkTool('double', rawAiTool);
    const toolExecutor = new CoreToolExecutor({ tools: { double: wrapped } });
    const { session, runStore, runState } = await setupDurableHarness();

    async function handler(ctx: Awaited<ReturnType<typeof buildCtx>>) {
      return ctx.tool('double', { x: 21 });
    }

    const ctx1 = await buildCtx({ session, runStore, runState, toolExecutor });
    expect(await handler(ctx1)).toEqual({ doubled: 42 });
    expect(execSpy.count).toBe(1);

    const ctx2 = await buildCtx({
      session,
      runStore,
      runState: await reloadRunState(runStore, runState.runId),
      toolExecutor,
    });
    expect(await handler(ctx2)).toEqual({ doubled: 42 });
    expect(execSpy.count).toBe(1);

    const steps = await runStore.getSteps(runState.runId);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.kind).toBe('tool');
    expect(steps[0]?.name).toBe('double');
  });

  it('throws when the AI SDK tool has no execute', () => {
    const schemaOnly = aiTool({
      description: 'Schema only',
      inputSchema: z.object({}),
    });
    expect(() => wrapAiSdkTool('bad', schemaOnly)).toThrow(/no execute/);
  });
});
