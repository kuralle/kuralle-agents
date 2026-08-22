import { describe, expect, it } from 'bun:test';
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test';
import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import { defineFlow, reply, decide, collect } from '../../src/types/flow.js';
import { makeRunState, makeTestSession } from '../core-durable/helpers.js';
import {
  mockV3GenerateResult,
  mockV3MultiStepStreamModel,
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

describe('llm spans', () => {
  it('records one llm span per model round-trip, parented to the node, reconciling tokensIn', async () => {
    const model = mockV3MultiStepStreamModel([
      () => mockV3ToolCallStreamWithUsage('lookup', 'call-llm', '{}', 100, 10),
      () => mockV3StreamWithUsage('Done.', 150, 20),
    ]);

    const lookup = defineTool({
      name: 'lookup',
      description: 'Lookup data',
      input: z.object({}),
      execute: async () => ({ ok: true }),
    });
    const ask = reply({
      id: 'ask',
      instructions: 'Use the lookup tool.',
      next: () => ({ end: 'done' }),
    });
    const flow = defineFlow({
      name: 'lookup-flow',
      description: 'Lookup then answer',
      start: ask,
      nodes: [ask],
    });
    const agent = defineAgent({
      id: 'llm-span-agent',
      instructions: 'Use the lookup tool.',
      model,
      tools: { lookup },
      flows: [flow],
    });

    const sessionId = 'trace-llm-spans';
    const sessionStore = new MemoryStore();
    await sessionStore.save(makeTestSession(sessionId));
    const runStore = new SessionRunStore(sessionStore, sessionId);
    const runState = makeRunState(sessionId, sessionId);
    runState.activeAgentId = agent.id;
    runState.activeFlow = flow.name;
    await runStore.initRun(runState);

    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      sessionStore,
    });

    const trace = await runtime.runOnce({ sessionId, input: 'Look it up' });

    const turn = trace.spans.find((span) => span.kind === 'turn');
    const node = trace.spans.find((span) => span.kind === 'node' && span.attributes.nodeId === 'ask');
    const llmSpans = trace.spans.filter((span) => span.kind === 'llm');

    expect(llmSpans).toHaveLength(2);
    expect(node).toBeDefined();
    for (const llm of llmSpans) {
      expect(llm.parentSpanId).toBe(node?.spanId);
      expect(llm.parentSpanId).not.toBe(turn?.spanId);
    }

    const summedInput = llmSpans.reduce((sum, span) => sum + (span.attributes.inputTokens ?? 0), 0);
    const tokensIn = turn?.attributes.tokensIn ?? -1;
    expect(tokensIn).toBe(250);
    expect(summedInput).toBe(tokensIn);
  });

  it('reconciles tokens across speaking and extraction calls', async () => {
    const model = mockV3MultiStepStreamModel([
      () =>
        mockV3ToolCallStreamWithUsage(
          'submit_name_data',
          'call-ex',
          JSON.stringify({ name: 'Riley' }),
          80,
          8,
        ),
      () => mockV3StreamWithUsage('Thanks Riley.', 120, 12),
    ]);

    const confirm = reply({
      id: 'confirm',
      instructions: 'Confirm the name.',
      next: () => ({ end: 'done' }),
    });
    const nameCollect = collect({
      id: 'name',
      schema: z.object({ name: z.string().min(1) }),
      required: ['name'],
      onComplete: () => confirm,
    });
    const flow = defineFlow({
      name: 'name-span-flow',
      description: 'Collect then confirm',
      start: nameCollect,
      nodes: [nameCollect, confirm],
    });
    const agent = defineAgent({
      id: 'name-span-agent',
      instructions: 'Collect names.',
      model,
      flows: [flow],
    });

    const sessionId = 'trace-extract-spans';
    const sessionStore = new MemoryStore();
    await sessionStore.save(makeTestSession(sessionId));
    const runStore = new SessionRunStore(sessionStore, sessionId);
    const runState = makeRunState(sessionId, sessionId);
    runState.activeAgentId = agent.id;
    runState.activeFlow = flow.name;
    await runStore.initRun(runState);

    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      sessionStore,
    });

    const trace = await runtime.runOnce({ sessionId, input: 'My name is Riley.' });

    const llmSpans = trace.spans.filter((span) => span.kind === 'llm');
    const turn = trace.spans.find((span) => span.kind === 'turn');
    expect(llmSpans.length).toBeGreaterThanOrEqual(2);
    const extractSpan = llmSpans.find((span) => (span.attributes.inputTokens ?? 0) === 80);
    expect(extractSpan).toBeDefined();
    expect((extractSpan?.attributes.inputTokens ?? 0) > 0).toBe(true);
    expect(turn?.attributes.tokensIn).toBe(200);
    const summedInput = llmSpans.reduce((sum, span) => sum + (span.attributes.inputTokens ?? 0), 0);
    const tokensIn = turn?.attributes.tokensIn ?? -1;
    expect(summedInput).toBe(tokensIn);
  });

  it('records control-path llm spans on decide-node transitions', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => mockV3GenerateResult(JSON.stringify({ choice: 'checkout' }), 55),
    });

    const checkout = reply({
      id: 'checkout',
      instructions: 'Checkout',
      next: () => ({ end: 'done' }),
    });
    const cart = decide({
      id: 'cart',
      instructions: 'Review cart',
      schema: z.object({ choice: z.string() }),
      decide: () => 'stay',
    });
    cart.choices = [
      { id: 'checkout', label: 'Checkout' },
      { id: 'more', label: 'Add more' },
    ];
    const flow = defineFlow({
      name: 'decide-span-flow',
      description: 'Decide flow',
      start: cart,
      nodes: [cart, checkout],
    });
    const agent = defineAgent({
      id: 'decide-span-agent',
      instructions: 'Help with cart',
      model,
      flows: [flow],
    });

    const sessionId = 'trace-decide-spans';
    const sessionStore = new MemoryStore();
    await sessionStore.save(makeTestSession(sessionId));
    const runStore = new SessionRunStore(sessionStore, sessionId);
    const runState = makeRunState(sessionId, sessionId);
    runState.activeAgentId = agent.id;
    runState.activeFlow = flow.name;
    runState.messages = [{ role: 'user', content: 'xyzzy unrelated gibberish' }];
    await runStore.initRun(runState);

    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      sessionStore,
    });

    const trace = await runtime.runOnce({ sessionId, input: 'still no keyword match here' });
    const controlLlms = trace.spans.filter(
      (span) => span.kind === 'llm' && span.attributes.controlPath === true,
    );
    expect(controlLlms.length).toBeGreaterThanOrEqual(1);
    expect(controlLlms[0]?.attributes.inputTokens).toBe(55);
  });

  it('reconciles decide plus reply tokens and parents controlPath spans to the turn', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => mockV3GenerateResult(JSON.stringify({ choice: 'continue' }), 55),
      doStream: async () => mockV3StreamWithUsage('finished', 100, 4),
    });

    const finish = reply({
      id: 'finish',
      instructions: 'Finish.',
      next: () => ({ end: 'done' }),
    });
    const choose = decide({
      id: 'choose',
      instructions: 'Choose.',
      schema: z.object({ choice: z.string() }),
      decide: () => finish,
    });
    const flow = defineFlow({
      name: 'mixed-llm-flow',
      description: 'Control plus speaking',
      start: choose,
      nodes: [choose, finish],
    });
    const agent = defineAgent({
      id: 'mixed-llm-agent',
      instructions: 'Help.',
      model,
      flows: [flow],
    });

    const sessionId = 'trace-mixed-llm';
    const sessionStore = new MemoryStore();
    await sessionStore.save(makeTestSession(sessionId));
    const runStore = new SessionRunStore(sessionStore, sessionId);
    const runState = makeRunState(sessionId, sessionId);
    runState.activeAgentId = agent.id;
    runState.activeFlow = flow.name;
    await runStore.initRun(runState);

    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      sessionStore,
    });
    const trace = await runtime.runOnce({ sessionId, input: 'unmatched input' });

    const turn = trace.spans.find((span) => span.kind === 'turn');
    const chooseNode = trace.spans.find(
      (span) => span.kind === 'node' && span.attributes.nodeId === 'choose',
    );
    const llms = trace.spans.filter((span) => span.kind === 'llm');
    const control = llms.find((span) => span.attributes.controlPath === true);
    const summedInput = llms.reduce(
      (sum, span) => sum + (span.attributes.inputTokens ?? 0),
      0,
    );

    expect(turn).toBeDefined();
    expect(chooseNode).toBeDefined();
    expect(control).toBeDefined();
    expect(turn!.attributes.tokensIn).toBe(155);
    expect(summedInput).toBe(155);
    const tokensIn = turn!.attributes.tokensIn as number;
    expect(summedInput).toBe(tokensIn);
    expect(control!.parentSpanId).toBe(turn!.spanId);
    expect(control!.parentSpanId === chooseNode!.spanId).toBe(false);
  });
});
