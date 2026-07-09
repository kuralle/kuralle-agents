import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { buildAgentReplyNode } from '../../src/runtime/agentReply.js';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import { CoreToolExecutor } from '../../src/tools/effect/ToolExecutor.js';
import { buildCtx, reloadRunState, setupDurableHarness } from '../core-durable/helpers.js';

const stub = {} as import('ai').LanguageModel;

describe('test:agentreply-journaled', () => {
  it('host-reply tools are schema-only and execute through the journal', async () => {
    const execSpy = { count: 0 };
    const ping = defineTool({
      name: 'ping',
      description: 'Return pong',
      input: z.object({ msg: z.string() }),
      execute: async ({ msg }) => {
        execSpy.count += 1;
        return { pong: msg };
      },
    });

    const agent = defineAgent({
      id: 'host',
      model: stub,
      tools: { ping },
    });

    const replyNode = buildAgentReplyNode(agent);
    expect(replyNode.tools).toBeDefined();
    const toolSet =
      typeof replyNode.tools === 'function' ? replyNode.tools({}) : replyNode.tools;
    expect(toolSet).toBeDefined();
    for (const entry of Object.values(toolSet ?? {})) {
      expect((entry as { execute?: unknown }).execute).toBeUndefined();
    }

    const toolExecutor = new CoreToolExecutor({ tools: { ping } });
    const { session, runStore, runState } = await setupDurableHarness();

    async function handler(ctx: Awaited<ReturnType<typeof buildCtx>>) {
      return ctx.tool('ping', { msg: 'hi' });
    }

    const ctx1 = await buildCtx({ session, runStore, runState, toolExecutor });
    expect(await handler(ctx1)).toEqual({ pong: 'hi' });
    expect(execSpy.count).toBe(1);

    const ctx2 = await buildCtx({
      session,
      runStore,
      runState: await reloadRunState(runStore, runState.runId),
      toolExecutor,
    });
    expect(await handler(ctx2)).toEqual({ pong: 'hi' });
    expect(execSpy.count).toBe(1);
  });
});
