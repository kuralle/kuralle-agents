import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { readOnlyPolicy } from '@kuralle-agents/core';
import { CoreToolExecutor } from '../../core/dist/tools/effect/index.js';
import { dispatchModelToolCalls } from '../../core/dist/runtime/channels/executeModelTool.js';
import { mcpTools } from '../src/index.js';
import { buildPolicyCtx, setupDurableHarness } from './helpers/durable-harness.js';
import { startStubMcpServer } from './helpers/stub-server.js';

/**
 * REQ-10 under *parallel* tool dispatch.
 *
 * The existing deny test dispatches one call. A model routinely emits several tool calls
 * in a single step, and this runtime executes them in parallel, so the interesting
 * question is whether a denial still holds when a denied call shares a batch with allowed
 * ones. A gate that holds for one call and leaks for two is worse than no gate, because
 * the single-call test reports green.
 */

function toolset(remoteCalls: { writes: number; reads: number }) {
  return [
    {
      name: 'write',
      description: 'Write data to storage',
      inputSchema: z.object({ data: z.string() }),
      handler: (args: Record<string, unknown>) => {
        remoteCalls.writes += 1;
        return { written: String(args.data ?? '') };
      },
    },
    {
      name: 'read',
      description: 'Read data',
      inputSchema: z.object({}),
      handler: () => {
        remoteCalls.reads += 1;
        return { data: 'ok' };
      },
    },
  ];
}

async function connect(remoteCalls: { writes: number; reads: number }) {
  const stub = startStubMcpServer({ tools: toolset(remoteCalls) });
  const { tools, close } = await mcpTools([
    { name: 'stub', type: 'streamable-http', url: stub.url },
  ]);
  return { stub, tools };
}

describe('MCP Policy deny under parallel dispatch (REQ-10)', () => {
  it('denies the write even when it shares a batch with allowed reads', async () => {
    const remoteCalls = { writes: 0, reads: 0 };
    const { stub, tools } = await connect(remoteCalls);

    try {
      const harness = await setupDurableHarness('parallel-deny-sess', 'parallel-deny-run');
      const ctx = await buildPolicyCtx({
        ...harness,
        toolExecutor: new CoreToolExecutor({ tools }),
        policy: readOnlyPolicy(['stub__write']),
      });

      const delivered: unknown[] = [];
      await dispatchModelToolCalls(
        ctx,
        [
          { toolName: 'stub__read', input: {}, toolCallId: 'p-read-1' },
          { toolName: 'stub__write', input: { data: 'secret' }, toolCallId: 'p-write' },
          { toolName: 'stub__read', input: {}, toolCallId: 'p-read-2' },
        ],
        tools,
        ({ outcome }) => delivered.push(outcome.result),
      );

      // The allowed siblings must still run — a gate that denies by breaking the batch
      // would pass this assertion's first half and be useless.
      expect(remoteCalls.reads).toBe(2);
      // The denied one must not have reached the network.
      expect(remoteCalls.writes).toBe(0);
      expect(delivered).toHaveLength(3);
    } finally {
      stub.close();
    }
  });

  it('denies every write when several denied calls share one batch', async () => {
    const remoteCalls = { writes: 0, reads: 0 };
    const { stub, tools } = await connect(remoteCalls);

    try {
      const harness = await setupDurableHarness('parallel-deny-many-sess', 'parallel-deny-many-run');
      const ctx = await buildPolicyCtx({
        ...harness,
        toolExecutor: new CoreToolExecutor({ tools }),
        policy: readOnlyPolicy(['stub__write']),
      });

      await dispatchModelToolCalls(
        ctx,
        Array.from({ length: 5 }, (_, i) => ({
          toolName: 'stub__write',
          input: { data: `secret-${i}` },
          toolCallId: `many-${i}`,
        })),
        tools,
        () => {},
      );

      expect(remoteCalls.writes).toBe(0);
    } finally {
      stub.close();
    }
  });
});
