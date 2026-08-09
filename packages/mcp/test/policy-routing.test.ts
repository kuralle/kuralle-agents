import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  readOnlyPolicy,
  type Policy,
  type PolicyRequest,
} from '@kuralle-agents/core';
import { CoreToolExecutor } from '../../core/dist/tools/effect/index.js';
import { dispatchModelToolCalls } from '../../core/dist/runtime/channels/executeModelTool.js';
import { SuspendError } from '../../core/dist/runtime/durable/RunStore.js';
import { recordSignalDelivery } from '../../core/dist/runtime/durable/replay.js';
import { mcpTools } from '../src/index.js';
import { buildPolicyCtx, setupDurableHarness } from './helpers/durable-harness.js';
import { startStubMcpServer } from './helpers/stub-server.js';

const APPROVAL_SIGNAL = '__approval';

function writeTool(remoteCalls: { count: number }) {
  return {
    name: 'write',
    description: 'Write data to storage',
    inputSchema: z.object({ data: z.string() }),
    handler: (args: Record<string, unknown>) => {
      remoteCalls.count += 1;
      return { written: String(args.data ?? '') };
    },
  };
}

async function connectWriteTool(remoteCalls: { count: number }) {
  const stub = startStubMcpServer({
    tools: [
      writeTool(remoteCalls),
      {
        name: 'read',
        description: 'Read data',
        inputSchema: z.object({}),
        handler: () => ({ data: 'ok' }),
      },
    ],
  });

  const { tools, close } = await mcpTools([
    {
      name: 'stub',
      type: 'streamable-http',
      url: stub.url,
    },
  ]);

  return { stub, tools };
}

describe('MCP tools route through Policy.decide', () => {
  it('reaches Policy.decide when invoked via the runtime executor', async () => {
    const remoteCalls = { count: 0 };
    const decideCalls: PolicyRequest[] = [];
    const policy: Policy = {
      decide: async (req) => {
        decideCalls.push(req);
        return { kind: 'allow' };
      },
    };

    const { stub, tools } = await connectWriteTool(remoteCalls);
    try {
      expect(Object.keys(tools)).toContain('stub__write');

      const harness = await setupDurableHarness('policy-path-sess', 'policy-path-run');
      const ctx = await buildPolicyCtx({
        ...harness,
        toolExecutor: new CoreToolExecutor({ tools }),
        policy,
      });

      const call = { toolName: 'stub__write', input: { data: 'hello' }, toolCallId: 'c-path' };
      const results: unknown[] = [];
      await dispatchModelToolCalls(ctx, [call], tools, ({ outcome }) =>
        results.push(outcome.result),
      );

      expect(decideCalls).toHaveLength(1);
      expect(decideCalls[0]?.toolName).toBe('stub__write');
      expect(decideCalls[0]?.def?.replay).toBe(true);
      expect(remoteCalls.count).toBe(1);
      expect(results).toHaveLength(1);
      expect(String(results[0])).toContain('hello');
    } finally {
      stub.close();
    }
  });

  it('deny prevents execution and the remote server records zero calls for stub__write', async () => {
    const remoteCalls = { count: 0 };
    const policy = readOnlyPolicy(['stub__write']);

    const { stub, tools } = await connectWriteTool(remoteCalls);
    try {
      const harness = await setupDurableHarness('policy-deny-sess', 'policy-deny-run');
      const ctx = await buildPolicyCtx({
        ...harness,
        toolExecutor: new CoreToolExecutor({ tools }),
        policy,
      });

      const delivered: unknown[] = [];
      await dispatchModelToolCalls(
        ctx,
        [{ toolName: 'stub__write', input: { data: 'secret' }, toolCallId: 'c-deny' }],
        tools,
        ({ outcome }) => delivered.push(outcome.result),
      );

      expect(remoteCalls.count).toBe(0);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({
        __denied: true,
        toolName: 'stub__write',
      });
    } finally {
      stub.close();
    }
  });

  it('ask suspends the turn and executes stub__write exactly once after approval', async () => {
    const remoteCalls = { count: 0 };
    const policy: Policy = {
      decide: ({ toolName }) =>
        toolName === 'stub__write'
          ? { kind: 'ask', title: 'Approve MCP write?' }
          : { kind: 'allow' },
    };

    const { stub, tools } = await connectWriteTool(remoteCalls);
    try {
      const harness = await setupDurableHarness('policy-ask-sess', 'policy-ask-run');
      const call = { toolName: 'stub__write', input: { data: 'payload' }, toolCallId: 'c-ask' };

      const ctx = await buildPolicyCtx({
        ...harness,
        toolExecutor: new CoreToolExecutor({ tools }),
        policy,
      });

      await expect(
        dispatchModelToolCalls(ctx, [call], tools, () => {}),
      ).rejects.toBeInstanceOf(SuspendError);
      expect(remoteCalls.count).toBe(0);

      const paused = (await harness.runStore.getRunState(harness.runState.runId))!;
      expect(paused.status).toBe('paused');
      expect(paused.waitingFor?.signalName).toBe(APPROVAL_SIGNAL);
      expect(
        (await harness.runStore.getSteps(harness.runState.runId)).filter(
          (step) => step.kind === 'tool' && step.name === 'stub__write',
        ),
      ).toHaveLength(0);

      await recordSignalDelivery(harness.runStore, paused, {
        signalId: 'sig-mcp-approve',
        requestId: paused.waitingFor!.requestId,
        name: APPROVAL_SIGNAL,
        actor: { id: 'supervisor', type: 'user' },
        decision: 'approve',
      });

      const resumed = (await harness.runStore.getRunState(harness.runState.runId))!;
      const resumedCtx = await buildPolicyCtx({
        ...harness,
        runState: resumed,
        toolExecutor: new CoreToolExecutor({ tools }),
        policy,
      });

      const results: unknown[] = [];
      await dispatchModelToolCalls(resumedCtx, [call], tools, ({ outcome }) =>
        results.push(outcome.result),
      );

      expect(results).toHaveLength(1);
      expect(String(results[0])).toContain('payload');
      expect(remoteCalls.count).toBe(1);

      const journalEntries = (await harness.runStore.getSteps(harness.runState.runId)).filter(
        (step) => step.kind === 'tool' && step.name === 'stub__write',
      );
      expect(journalEntries).toHaveLength(1);
    } finally {
      stub.close();
    }
  });
});

describe('MCP tools discovery filter', () => {
  it('throws when both allow and block are set at wiring time', async () => {
    const stub = startStubMcpServer({ tools: [writeTool({ count: 0 })] });
    try {
      await expect(
        mcpTools(
          [
            {
              name: 'stub',
              type: 'streamable-http',
              url: stub.url,
            },
          ],
          {
            tools: {
              allow: ['stub__write'],
              block: ['stub__read'],
            },
          },
        ),
      ).rejects.toThrow(/set either "allow" or "block", not both/);
    } finally {
      stub.close();
    }
  });

  it('projects only allow-listed tools at discovery time', async () => {
    const stub = startStubMcpServer({
      tools: [writeTool({ count: 0 }), {
        name: 'read',
        description: 'Read data',
        inputSchema: z.object({}),
        handler: () => ({ data: 'ok' }),
      }],
    });
    try {
      const { tools, close } = await mcpTools(
        [{ name: 'stub', type: 'streamable-http', url: stub.url }],
        { tools: { allow: ['stub__write'] } },
      );
      expect(Object.keys(tools)).toEqual(['stub__write']);
    } finally {
      stub.close();
    }
  });

  it('omits block-listed tools at discovery time', async () => {
    const stub = startStubMcpServer({
      tools: [writeTool({ count: 0 }), {
        name: 'read',
        description: 'Read data',
        inputSchema: z.object({}),
        handler: () => ({ data: 'ok' }),
      }],
    });
    try {
      const { tools, close } = await mcpTools(
        [{ name: 'stub', type: 'streamable-http', url: stub.url }],
        { tools: { block: ['stub__write'] } },
      );
      expect(Object.keys(tools)).toEqual(['stub__read']);
    } finally {
      stub.close();
    }
  });
});
