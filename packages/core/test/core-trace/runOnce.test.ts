import { afterEach, describe, expect, it, mock } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import { stubModel } from '../core-durable/helpers.js';
import { z } from 'zod';

afterEach(() => {
  mock.restore();
});

describe('Runtime.runOnce', () => {
  it('returns a single-run text trace', async () => {
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: () => ({
          fullStream: (async function* () {
            yield Object.assign({ type: 'text-delta' }, { text: 'Grounded answer.' });
          })(),
          finishReason: Promise.resolve('stop'),
          response: Promise.resolve({ messages: [] }),
          toolCalls: Promise.resolve([]),
        }),
      };
    });

    const agent = defineAgent({ id: 'support', instructions: 'Help the user.', model: stubModel });
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
    let modelCall = 0;
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: () => {
          modelCall += 1;
          if (modelCall === 1) {
            return {
              fullStream: (async function* () {})(),
              finishReason: Promise.resolve('tool-calls'),
              response: Promise.resolve({ messages: [] }),
              toolCalls: Promise.resolve([
                { toolName: 'last_invoice', toolCallId: 'call-1', input: { customerId: 'c-7' } },
              ]),
            };
          }
          return {
            fullStream: (async function* () {
              yield Object.assign({ type: 'text-delta' }, { text: 'Invoice total: $42.' });
            })(),
            finishReason: Promise.resolve('stop'),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve([]),
          };
        },
      };
    });

    const lastInvoice = defineTool({
      name: 'last_invoice',
      description: 'Look up the last invoice',
      input: z.object({ customerId: z.string() }),
      execute: async ({ customerId }) => ({ customerId, total: 42 }),
    });
    const agent = defineAgent({
      id: 'billing',
      instructions: 'Use billing tools.',
      model: stubModel,
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
    let modelCall = 0;
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: () => {
          modelCall += 1;
          if (modelCall === 1) {
            return {
              fullStream: (async function* () {})(),
              finishReason: Promise.resolve('tool-calls'),
              response: Promise.resolve({ messages: [] }),
              toolCalls: Promise.resolve([
                { toolName: 'lookup', toolCallId: 'call-usage', input: {} },
              ]),
              totalUsage: Promise.resolve({
                inputTokens: 100,
                outputTokens: 10,
                totalTokens: 110,
              }),
            };
          }
          return {
            fullStream: (async function* () {
              yield Object.assign({ type: 'text-delta' }, { text: 'Done.' });
            })(),
            finishReason: Promise.resolve('stop'),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve([]),
            totalUsage: Promise.resolve({
              inputTokens: 150,
              outputTokens: 20,
              totalTokens: 170,
            }),
          };
        },
      };
    });

    const lookup = defineTool({
      name: 'lookup',
      description: 'Lookup data',
      input: z.object({}),
      execute: async () => ({ ok: true }),
    });
    const agent = defineAgent({
      id: 'usage',
      instructions: 'Use the lookup tool.',
      model: stubModel,
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
