import { describe, expect, it } from 'bun:test';
import { action, defineAgent } from '../../src/authoring/index.js';
import { CoreToolExecutor } from '../../src/tools/effect/ToolExecutor.js';
import { InMemoryFs } from '@kuralle-agents/fs';
import { buildCtx, reloadRunState, setupDurableHarness } from '../core-durable/helpers.js';

describe('test:workspace-autoregister', () => {
  it('registers workspace tool and sets ctx.fs for action nodes', async () => {
    const workspace = new InMemoryFs({ '/kb/faq.md': 'FAQ content' });
    const agent = defineAgent({
      id: 'kb',
      instructions: 'KB agent',
      workspace,
    });

    const captured: { hasFs: boolean; listed: unknown } = { hasFs: false, listed: null };
    const probe = action({
      id: 'probe',
      run: async (_state, ctx) => {
        captured.hasFs = ctx.fs === workspace;
        if (ctx.fs) {
          captured.listed = await ctx.fs.readdir('/kb');
        }
        return { end: 'done' };
      },
    });

    const agentTools: Record<string, import('../../src/types/effectTool.js').AnyTool> = {};
    if (agent.workspace) {
      const { createFsTool } = await import('@kuralle-agents/fs');
      agentTools.workspace = createFsTool({ fs: agent.workspace });
    }

    expect(agentTools.workspace).toBeDefined();
    expect(agentTools.workspace?.name).toBe('workspace');

    const toolExecutor = new CoreToolExecutor({ tools: agentTools });
    const { session, runStore, runState } = await setupDurableHarness();

    const ctx = await buildCtx({
      session,
      runStore,
      runState,
      toolExecutor,
      fs: agent.workspace,
    });

    expect(ctx.fs).toBe(workspace);

    const toolResult = await ctx.tool('workspace', { op: 'cat', path: '/kb/faq.md' });
    expect(toolResult).toMatchObject({
      op: 'cat',
      ok: true,
      content: 'FAQ content',
    });

    const steps = await runStore.getSteps(runState.runId);
    expect(steps.some((s) => s.kind === 'tool' && s.name === 'workspace')).toBe(true);

    await probe.run({}, ctx);
    expect(captured.hasFs).toBe(true);
    expect(captured.listed).toEqual(['faq.md']);

    const ctx2 = await buildCtx({
      session,
      runStore,
      runState: await reloadRunState(runStore, runState.runId),
      toolExecutor,
      fs: agent.workspace,
    });
    const replay = await ctx2.tool('workspace', { op: 'cat', path: '/kb/faq.md' });
    expect(replay).toMatchObject({ content: 'FAQ content' });
    const stepsAfter = await runStore.getSteps(runState.runId);
    expect(stepsAfter.filter((s) => s.kind === 'tool' && s.name === 'workspace')).toHaveLength(1);
  });
});
