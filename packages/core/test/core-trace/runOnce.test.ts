import { describe, expect, it } from 'bun:test';
import { simulateReadableStream } from 'ai/test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import { z } from 'zod';
import {
  mockV3MultiStepStreamModel,
  mockV3StreamResult,
  mockV3StreamTextModel,
  mockV3ToolCallStreamResult,
} from '../helpers/mockLanguageModelV3Results.js';

function streamUsage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTokens,
      text: outputTokens,
      reasoning: undefined,
    },
  };
}

function mockV3ToolCallStreamWithUsage(
  toolName: string,
  toolCallId: string,
  input: string,
  inputTokens: number,
  outputTokens: number,
) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'stream-start' as const, warnings: [] },
        { type: 'tool-call' as const, toolCallId, toolName, input },
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: streamUsage(inputTokens, outputTokens),
        },
      ],
    }),
  };
}

function mockV3StreamWithUsage(text: string, inputTokens: number, outputTokens: number) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id: 't0' },
        { type: 'text-delta' as const, id: 't0', delta: text },
        { type: 'text-end' as const, id: 't0' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: streamUsage(inputTokens, outputTokens),
        },
      ],
    }),
  };
}

describe('Runtime.runOnce', () => {
  it('returns a single-run text trace', async () => {
    const model = mockV3StreamTextModel('Grounded answer.');
    const agent = defineAgent({ id: 'support', instructions: 'Help the user.', model });
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      tracing: { sinks: [{ write: () => { throw new Error('telemetry offline'); } }] },
    });

    const trace = await runtime.runOnce({ sessionId: 'trace-text', input: 'Help me' });

    expect(trace.answer).toBe('Grounded answer.');
    expect(trace.usedTool).toBe(false);
    expect(trace.toolCalls).toEqual([]);
    expect(trace.toolResults).toEqual([]);
    expect(trace.spans.some((span) => span.kind === 'turn' && !span.parentSpanId)).toBe(true);
    expect(trace.spans.find((span) => span.kind === 'turn')?.attributes.agentId).toBe('support');
    const stored = await runtime.listTraces('trace-text');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.answer).toBe('Grounded answer.');
    expect(await runtime.getTrace(stored[0]!.traceId)).toEqual(stored[0]!);
  });

  it('records a tool call, result, and nested tool span', async () => {
    const model = mockV3MultiStepStreamModel([
      () =>
        mockV3ToolCallStreamResult(
          'last_invoice',
          'call-1',
          JSON.stringify({ customerId: 'c-7' }),
        ),
      () => mockV3StreamResult('Invoice total: $42.'),
    ]);

    const lastInvoice = defineTool({
      name: 'last_invoice',
      description: 'Look up the last invoice',
      input: z.object({ customerId: z.string() }),
      execute: async ({ customerId }) => ({ customerId, total: 42 }),
    });
    const agent = defineAgent({
      id: 'billing',
      instructions: 'Use billing tools.',
      model,
      tools: { last_invoice: lastInvoice },
    });
    const runtime = createRuntime({ agents: [agent], defaultAgentId: agent.id });

    const trace = await runtime.runOnce({ sessionId: 'trace-tool', input: 'Last invoice?' });

    expect(trace.usedTool).toBe(true);
    expect(trace.toolCalls).toEqual([
      { name: 'last_invoice', args: { customerId: 'c-7' } },
    ]);
    expect(trace.toolResults).toEqual([
      { name: 'last_invoice', result: { customerId: 'c-7', total: 42 } },
    ]);
    const turn = trace.spans.find((span) => span.kind === 'turn');
    const tool = trace.spans.find((span) => span.kind === 'tool');
    expect(tool?.parentSpanId).toBe(turn?.spanId);
    expect(() => JSON.stringify(trace)).not.toThrow();
  });

  it('reports summed turn cost but only the final tool-loop prompt as context tokens', async () => {
    const model = mockV3MultiStepStreamModel([
      () => mockV3ToolCallStreamWithUsage('lookup', 'call-usage', '{}', 100, 10),
      () => mockV3StreamWithUsage('Done.', 150, 20),
    ]);

    const lookup = defineTool({
      name: 'lookup',
      description: 'Lookup data',
      input: z.object({}),
      execute: async () => ({ ok: true }),
    });
    const agent = defineAgent({
      id: 'usage',
      instructions: 'Use the lookup tool.',
      model,
      tools: { lookup },
    });
    const runtime = createRuntime({ agents: [agent], defaultAgentId: agent.id });

    const trace = await runtime.runOnce({ sessionId: 'trace-usage', input: 'Look it up' });
    const turn = trace.spans.find((span) => span.kind === 'turn');

    expect(turn?.attributes.tokensIn).toBe(250);
    expect(turn?.attributes.tokensOut).toBe(30);
    expect(turn?.attributes.contextTokens).toBe(150);
  });
});
