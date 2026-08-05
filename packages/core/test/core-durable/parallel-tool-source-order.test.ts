import { describe, expect, it } from 'bun:test';
import type { StreamPart } from '../../src/types/stream.js';
import { CoreToolExecutor } from '../../src/tools/effect/ToolExecutor.js';
import {
  dispatchModelToolCalls,
  toolResultMessage,
  type ModelToolCall,
} from '../../src/runtime/channels/executeModelTool.js';
import { buildCtx, setupDurableHarness } from './helpers.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Three parallel-safe tools named by source position (1, 2, 3), each delaying by a distinct
 * amount so completion order is 3, 1, 2 — never source order — regardless of scheduling luck.
 */
function makeSourceOrderTools(delays: readonly [number, number, number]) {
  return {
    call_1: {
      name: 'call_1',
      description: 'First in source order',
      parallelSafe: true as const,
      execute: async () => {
        await delay(delays[0]);
        return { name: 'call_1' };
      },
    },
    call_2: {
      name: 'call_2',
      description: 'Second in source order',
      parallelSafe: true as const,
      execute: async () => {
        await delay(delays[1]);
        return { name: 'call_2' };
      },
    },
    call_3: {
      name: 'call_3',
      description: 'Third in source order',
      parallelSafe: true as const,
      execute: async () => {
        await delay(delays[2]);
        return { name: 'call_3' };
      },
    },
  };
}

const SOURCE_CALLS: ModelToolCall[] = [
  { toolName: 'call_1', input: {}, toolCallId: 'tc-1' },
  { toolName: 'call_2', input: {}, toolCallId: 'tc-2' },
  { toolName: 'call_3', input: {}, toolCallId: 'tc-3' },
];

describe('parallel tool batches emit and append in source order', () => {
  it('runs onEach, tool-result, and tool-batch-start in source order even when call 3 finishes first, then 1, then 2', async () => {
    // call_3 (index 2) resolves fastest, call_1 next, call_2 last: completion order is 3, 1, 2.
    const tools = makeSourceOrderTools([20, 40, 5]);
    const { session, runStore, runState } = await setupDurableHarness('order-sess', 'order-run');
    const emitted: StreamPart[] = [];
    const ctx = await buildCtx({
      session,
      runStore,
      runState,
      toolExecutor: new CoreToolExecutor({ tools }),
      emit: (part) => emitted.push(part),
    });

    const onEachOrder: string[] = [];
    await dispatchModelToolCalls(ctx, SOURCE_CALLS, tools, ({ call }) => {
      onEachOrder.push(call.toolName);
    });

    // (a) onEach fires in source order, not completion order.
    expect(onEachOrder).toEqual(['call_1', 'call_2', 'call_3']);

    // (b) tool-result parts land in source order.
    const toolResultOrder = emitted
      .filter((p) => p.type === 'tool-result')
      .map((p) => p.payload.toolName);
    expect(toolResultOrder).toEqual(['call_1', 'call_2', 'call_3']);

    // (c) exactly one tool-batch-start, source-order calls, before any tool-call.
    const batchStarts = emitted.filter((p) => p.type === 'tool-batch-start');
    expect(batchStarts).toHaveLength(1);
    expect(batchStarts[0]?.payload).toEqual({
      calls: [
        { toolCallId: 'tc-1', toolName: 'call_1' },
        { toolCallId: 'tc-2', toolName: 'call_2' },
        { toolCallId: 'tc-3', toolName: 'call_3' },
      ],
    });
    const batchStartIndex = emitted.indexOf(batchStarts[0]!);
    const firstToolCallIndex = emitted.findIndex((p) => p.type === 'tool-call');
    expect(batchStartIndex).toBeLessThan(firstToolCallIndex);

    // tool-call parts are also emitted in source order, all before any tool-result.
    const toolCallOrder = emitted.filter((p) => p.type === 'tool-call').map((p) => p.payload.toolName);
    expect(toolCallOrder).toEqual(['call_1', 'call_2', 'call_3']);
    const lastToolCallIndex = emitted.map((p) => p.type).lastIndexOf('tool-call');
    const firstToolResultIndex = emitted.findIndex((p) => p.type === 'tool-result');
    expect(lastToolCallIndex).toBeLessThan(firstToolResultIndex);
  });

  it('produces byte-identical toolMessages across two runs with shuffled completion delays', async () => {
    async function runOnce(delays: readonly [number, number, number], sessionId: string, runId: string) {
      const tools = makeSourceOrderTools(delays);
      const { session, runStore, runState } = await setupDurableHarness(sessionId, runId);
      const ctx = await buildCtx({
        session,
        runStore,
        runState,
        toolExecutor: new CoreToolExecutor({ tools }),
      });

      const toolMessages: unknown[] = [];
      await dispatchModelToolCalls(ctx, SOURCE_CALLS, tools, ({ call, outcome }) => {
        toolMessages.push(toolResultMessage(call, outcome.result));
      });
      return toolMessages;
    }

    // Two runs of the same source-order batch, with completion order shuffled differently
    // each time (3,1,2 then 2,3,1) — a replay must rebuild the same transcript regardless.
    const first = await runOnce([20, 40, 5], 'replay-sess-a', 'replay-run-a');
    const second = await runOnce([15, 5, 30], 'replay-sess-b', 'replay-run-b');

    expect(second).toEqual(first);
  });
});
