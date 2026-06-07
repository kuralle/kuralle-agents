import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineAgent, defineTool } from '@kuralle-agents/core';
import { CoreToolExecutor } from '../../kuralle-core/src/tools/effect/ToolExecutor.js';
import { defineSkill } from '../src/defineSkill.js';
import { wireAgentSkills } from '../src/wireAgentSkills.js';
import { buildCtx, reloadRunState, setupDurableHarness } from '../../kuralle-core/test/core-durable/helpers.js';

describe('test:skill-agent', () => {
  const lookupOrder = defineTool({
    name: 'lookup_order',
    description: 'Fetch order status.',
    input: z.object({ orderId: z.string() }),
    execute: async ({ orderId }) => ({ orderId, status: 'shipped' }),
  });

  const returnsPolicy = defineSkill({
    name: 'returns-policy',
    description: 'Return policy guidance.',
    body: 'Run lookup_order with the order id.',
    allowedTools: ['lookup_order'],
  });

  it('loads skill on demand and runs allow-listed script tool through journal', async () => {
    const agent = defineAgent({
      id: 'support',
      instructions: 'Support agent',
      tools: { lookup_order: lookupOrder },
      skills: [returnsPolicy],
    });

    const wired = await wireAgentSkills(agent);
    expect(wired?.tools.load_skill).toBeDefined();

    const agentTools = {
      lookup_order: lookupOrder,
      ...wired!.tools,
    };

    const toolExecutor = new CoreToolExecutor({ tools: agentTools });
    const { session, runStore, runState } = await setupDurableHarness();
    const ctx = await buildCtx({ session, runStore, runState, toolExecutor });

    const loaded = await ctx.tool('load_skill', { name: 'returns-policy' });
    expect(loaded).toMatchObject({ body: 'Run lookup_order with the order id.' });

    const order = await ctx.tool('lookup_order', { orderId: 'A123' });
    expect(order).toMatchObject({ orderId: 'A123', status: 'shipped' });

    const steps = await runStore.getSteps(runState.runId);
    expect(steps.filter((s) => s.kind === 'tool' && s.name === 'load_skill')).toHaveLength(1);
    expect(steps.filter((s) => s.kind === 'tool' && s.name === 'lookup_order')).toHaveLength(1);

    const ctx2 = await buildCtx({
      session,
      runStore,
      runState: await reloadRunState(runStore, runState.runId),
      toolExecutor,
    });
    const replayLoad = await ctx2.tool('load_skill', { name: 'returns-policy' });
    expect(replayLoad).toMatchObject({ body: 'Run lookup_order with the order id.' });
    const replayOrder = await ctx2.tool('lookup_order', { orderId: 'A123' });
    expect(replayOrder).toMatchObject({ status: 'shipped' });

    const stepsAfter = await runStore.getSteps(runState.runId);
    expect(stepsAfter.filter((s) => s.kind === 'tool' && s.name === 'load_skill')).toHaveLength(1);
    expect(stepsAfter.filter((s) => s.kind === 'tool' && s.name === 'lookup_order')).toHaveLength(1);
  });
});
