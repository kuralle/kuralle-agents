import { describe, expect, it } from 'bun:test';
import { AssistantMessageEventStream, type Api, type AssistantMessage, type Context, type Model, type Usage } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createRuntime, defineTool, type StreamPart } from '@kuralle-agents/core';
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { PiDriver } from '../src/index.js';
import { createRunContext } from '../../core/dist/runtime/ctx.js';
import { CoreToolExecutor } from '../../core/dist/tools/effect/ToolExecutor.js';
import { decide, reply } from '../../core/dist/types/flow.js';
import { resolveReplyNode } from '../../core/dist/flow/nodeBuilders.js';
import { setupDurableHarness } from '../../core/test/core-durable/helpers.js';

const AI_MODEL = { provider: 'test', modelId: 'ai-model' } as LanguageModel;
const PI_MODEL: Model<Api> = {
  id: 'pi-model',
  name: 'Pi model',
  api: 'test',
  provider: 'test',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4_096,
};

function usage(input = 10, output = 2): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function assistant(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: PI_MODEL.api,
    provider: PI_MODEL.provider,
    model: PI_MODEL.id,
    usage: usage(),
    stopReason,
    timestamp: Date.now(),
  };
}

function textStream(chunks: string[]): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  const partial = assistant([], 'stop');
  stream.push({ type: 'start', partial });
  let text = '';
  let current = assistant([{ type: 'text', text }], 'stop');
  stream.push({ type: 'text_start', contentIndex: 0, partial: current });
  for (const delta of chunks) {
    text += delta;
    current = assistant([{ type: 'text', text }], 'stop');
    stream.push({ type: 'text_delta', contentIndex: 0, delta, partial: current });
  }
  stream.push({ type: 'text_end', contentIndex: 0, content: text, partial: current });
  stream.push({ type: 'done', reason: 'stop', message: current });
  return stream;
}

function toolCallStream(calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();
  const partial = assistant([], 'toolUse');
  stream.push({ type: 'start', partial });
  const content = calls.map((call) => ({ type: 'toolCall' as const, ...call }));
  let current = assistant([], 'toolUse');
  for (let index = 0; index < content.length; index += 1) {
    current = assistant(content.slice(0, index + 1), 'toolUse');
    stream.push({ type: 'toolcall_start', contentIndex: index, partial: current });
    stream.push({ type: 'toolcall_end', contentIndex: index, toolCall: content[index]!, partial: current });
  }
  stream.push({ type: 'done', reason: 'toolUse', message: current });
  return stream;
}

async function runTurn(streamFn: StreamFn, tools: Record<string, ReturnType<typeof defineTool>> = {}) {
  const runtime = createRuntime({
    agents: [{
      id: 'agent',
      name: 'Agent',
      model: AI_MODEL,
      instructions: 'Answer precisely.',
      tools,
    }],
    defaultAgentId: 'agent',
    driver: new PiDriver({ model: PI_MODEL, streamFn }),
  });
  const handle = runtime.run({ sessionId: crypto.randomUUID(), input: 'hello' });
  const parts: StreamPart[] = [];
  for await (const part of handle.events) parts.push(part);
  return { result: await handle, parts };
}

async function runDriverTurn(
  streamFn: StreamFn,
  tools: Record<string, ReturnType<typeof defineTool>> = {},
) {
  const parts: StreamPart[] = [];
  const id = crypto.randomUUID();
  const { session, runStore, runState } = await setupDurableHarness(id, `${id}-run`);
  runState.messages = [{ role: 'user', content: 'hello' }];
  const ctx = await createRunContext({
    session,
    runStore,
    runState,
    steps: [],
    toolExecutor: new CoreToolExecutor({ tools: {} }),
    model: AI_MODEL,
    emit: (part) => parts.push(part),
  });
  const resolved = resolveReplyNode(reply({ id: 'pi-turn', instructions: 'Answer precisely.' }), {});
  resolved.localTools = tools;
  const result = await new PiDriver({ model: PI_MODEL, streamFn }).runAgentTurn(resolved, ctx);
  return { result, parts };
}

describe('PiDriver', () => {
  it('runs Pi inside Kuralle and preserves streaming, usage, and turn framing', async () => {
    let context: Context | undefined;
    const streamFn: StreamFn = (_model, value) => {
      context = value;
      return textStream(['Hello', ' from', ' Pi']);
    };

    const { result, parts } = await runTurn(streamFn);

    expect(result.text).toBe('Hello from Pi');
    const modelEnd = parts.find((part) => part.type === 'model-call-end');
    expect(modelEnd?.type === 'model-call-end' && modelEnd.payload).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
    });
    expect(context?.systemPrompt).toContain('Answer precisely.');
    expect(context?.messages.some((message) => message.role === 'user')).toBe(true);
    expect(parts.filter((part) => part.type === 'text-delta').map((part) => part.payload.delta)).toEqual([
      'Hello',
      ' from',
      ' Pi',
    ]);
    expect(parts.filter((part) => part.type === 'model-call-start')).toHaveLength(1);
    expect(parts.filter((part) => part.type === 'model-call-end')).toHaveLength(1);
  });

  it('closes model-call telemetry when the Pi transport fails before a turn ends', async () => {
    const parts: StreamPart[] = [];
    const { session, runStore, runState } = await setupDurableHarness('pi-error', 'pi-error-run');
    runState.messages = [{ role: 'user', content: 'hello' }];
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: AI_MODEL,
      emit: (part) => parts.push(part),
    });
    const resolved = resolveReplyNode(reply({ id: 'pi-error-node', instructions: 'Answer.' }), {});
    const streamFn: StreamFn = () => {
      throw new Error('transport unavailable');
    };

    await expect(
      new PiDriver({ model: PI_MODEL, streamFn }).runAgentTurn(resolved, ctx),
    ).rejects.toThrow('transport unavailable');
    expect(parts.filter((part) => part.type === 'model-call-start')).toHaveLength(1);
    expect(parts.filter((part) => part.type === 'model-call-end')).toHaveLength(1);
    expect(parts.find((part) => part.type === 'model-call-end')?.payload).toMatchObject({
      finishReason: 'error',
    });
  });

  it('executes tools through Kuralle durability and returns the result to Pi', async () => {
    let requests = 0;
    let executions = 0;
    const echo = defineTool({
      name: 'echo',
      description: 'Echo a value',
      input: z.object({ value: z.string() }),
      parallelSafe: true,
      async execute(args) {
        executions += 1;
        return { echoed: args.value };
      },
    });
    const streamFn: StreamFn = (_model, context) => {
      requests += 1;
      if (requests === 1) {
        expect(context.tools?.[0]?.name).toBe('echo');
        return toolCallStream([{ id: 'echo-1', name: 'echo', arguments: { value: 'works' } }]);
      }
      const toolResult = context.messages.findLast((message) => message.role === 'toolResult');
      expect(toolResult?.toolCallId).toBe('echo-1');
      expect(toolResult?.details).toEqual({ echoed: 'works' });
      return textStream(['Tool complete']);
    };

    const { result, parts } = await runDriverTurn(streamFn, { echo });

    expect(requests).toBe(2);
    expect(executions).toBe(1);
    expect(result.text).toBe('Tool complete');
    expect(parts.filter((part) => part.type === 'tool-call')).toHaveLength(1);
    const toolResults = parts.filter((part) => part.type === 'tool-result');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]?.payload).toMatchObject({
      toolName: 'echo',
      toolCallId: 'echo-1',
      result: { echoed: 'works' },
    });
  });

  it('projects Kuralle tool failures back into Pi and persisted history', async () => {
    const echo = defineTool({
      name: 'echo',
      description: 'Echo a value',
      input: z.object({ value: z.string() }),
      parallelSafe: true,
      async execute(args) {
        return { echoed: args.value };
      },
    });
    let requests = 0;
    const streamFn: StreamFn = (_model, context) => {
      requests += 1;
      if (requests === 1) {
        return toolCallStream([{ id: 'invalid-1', name: 'echo', arguments: { value: 42 } }]);
      }
      const rejected = context.messages.findLast((message) => message.role === 'toolResult');
      expect(rejected?.toolCallId).toBe('invalid-1');
      expect(rejected?.isError).toBe(true);
      return textStream(['Recovered']);
    };

    const { result, parts } = await runDriverTurn(streamFn, { echo });

    expect(result.text).toBe('Recovered');
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]).toMatchObject({
      name: 'echo',
      args: { value: 42 },
      toolCallId: 'invalid-1',
    });
    expect(result.toolMessages).toHaveLength(2);
    const persistedResult = result.toolMessages?.find((message) => message.role === 'tool');
    expect(persistedResult?.role === 'tool' && persistedResult.content[0]?.output.type).toBe('error-json');
    expect(parts.filter((part) => part.type === 'tool-call')).toHaveLength(1);
    expect(parts.filter((part) => part.type === 'tool-result')).toHaveLength(1);
  });

  it('persists Pi-side unknown-tool failures as matched Kuralle history', async () => {
    let requests = 0;
    const streamFn: StreamFn = (_model, context) => {
      requests += 1;
      if (requests === 1) {
        return toolCallStream([{ id: 'unknown-1', name: 'missing_tool', arguments: { value: 42 } }]);
      }
      const rejected = context.messages.findLast((message) => message.role === 'toolResult');
      expect(rejected?.toolCallId).toBe('unknown-1');
      expect(rejected?.isError).toBe(true);
      return textStream(['Recovered']);
    };

    const { result, parts } = await runDriverTurn(streamFn);

    expect(result.text).toBe('Recovered');
    expect(result.toolResults[0]).toMatchObject({
      name: 'missing_tool',
      args: { value: 42 },
      toolCallId: 'unknown-1',
    });
    const persistedResult = result.toolMessages?.find((message) => message.role === 'tool');
    expect(persistedResult?.role === 'tool' && persistedResult.content[0]?.output.type).toBe('error-text');
    expect(parts.filter((part) => part.type === 'tool-call')).toHaveLength(1);
    expect(parts.filter((part) => part.type === 'tool-result')).toHaveLength(1);
  });

  it('keeps Kuralle parallel-safe batching when Pi emits multiple calls', async () => {
    let active = 0;
    let peak = 0;
    let started = 0;
    let release!: () => void;
    const bothStarted = new Promise<void>((resolve) => { release = resolve; });
    const makeTool = (name: string) => defineTool({
      name,
      description: name,
      input: z.object({ value: z.number() }),
      parallelSafe: true,
      async execute(args) {
        active += 1;
        peak = Math.max(peak, active);
        started += 1;
        if (started === 2) release();
        await bothStarted;
        active -= 1;
        return { value: args.value };
      },
    });
    let request = 0;
    const streamFn: StreamFn = () => {
      request += 1;
      return request === 1
        ? toolCallStream([
            { id: 'a-1', name: 'first', arguments: { value: 1 } },
            { id: 'b-1', name: 'second', arguments: { value: 2 } },
          ])
        : textStream(['done']);
    };

    const { parts } = await runTurn(streamFn, { first: makeTool('first'), second: makeTool('second') });

    expect(peak).toBe(2);
    expect(parts.filter((part) => part.type === 'tool-result').map((part) => part.payload.toolCallId)).toEqual([
      'a-1',
      'b-1',
    ]);
  });

  it('keeps unsafe tools sequential even though Pi requests a parallel batch', async () => {
    const order: string[] = [];
    let active = 0;
    let peak = 0;
    const makeTool = (name: string) => defineTool({
      name,
      description: name,
      input: z.object({}),
      async execute() {
        active += 1;
        peak = Math.max(peak, active);
        order.push(`${name}:start`);
        await Promise.resolve();
        order.push(`${name}:end`);
        active -= 1;
        return { name };
      },
    });
    let request = 0;
    const streamFn: StreamFn = () => {
      request += 1;
      return request === 1
        ? toolCallStream([
            { id: 'unsafe-a', name: 'first', arguments: {} },
            { id: 'unsafe-b', name: 'second', arguments: {} },
          ])
        : textStream(['done']);
    };

    await runDriverTurn(streamFn, { first: makeTool('first'), second: makeTool('second') });

    expect(peak).toBe(1);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('rejects duplicate tool-call ids without hanging or executing either call', async () => {
    let executions = 0;
    const echo = defineTool({
      name: 'echo',
      description: 'Echo',
      input: z.object({ value: z.string() }),
      async execute() {
        executions += 1;
        return 'unexpected';
      },
    });
    const streamFn: StreamFn = () => toolCallStream([
      { id: 'duplicate', name: 'echo', arguments: { value: 'one' } },
      { id: 'duplicate', name: 'echo', arguments: { value: 'two' } },
    ]);

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(Promise.race([
        runDriverTurn(streamFn, { echo }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('driver hung')), 500);
        }),
      ])).rejects.toThrow(/duplicate toolCallId/);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    expect(executions).toBe(0);
  });

  it('can run typed collect extraction through Pi without speaking', async () => {
    const submit = defineTool({
      name: 'submit_profile_data',
      description: 'Submit extracted profile fields',
      input: z.object({ name: z.string() }),
      async execute(args) {
        return args;
      },
    });
    let requests = 0;
    const streamFn: StreamFn = () => {
      requests += 1;
      return toolCallStream([
        { id: 'submit-1', name: 'submit_profile_data', arguments: { name: 'Ada' } },
      ]);
    };
    const parts: StreamPart[] = [];
    const { session, runStore, runState } = await setupDurableHarness('pi-extract', 'pi-extract-run');
    runState.messages = [{ role: 'user', content: 'My name is Ada' }];
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: AI_MODEL,
      controlModel: AI_MODEL,
      emit: (part) => parts.push(part),
    });
    const resolved = resolveReplyNode(
      reply({ id: 'collect-profile', instructions: 'Extract the profile.' }),
      {},
    );
    resolved.localTools = { submit_profile_data: submit };
    resolved.toolScope = 'closed';
    resolved.extractionSatisfied = async (results) => results.some(
      (entry) => entry.name === 'submit_profile_data' && (entry.result as { name?: string }).name === 'Ada',
    );

    const result = await new PiDriver({
      model: PI_MODEL,
      streamFn,
    }).runExtraction(resolved, ctx);

    expect(requests).toBe(1);
    expect(result.text).toBe('');
    expect(result.toolResults[0]).toMatchObject({
      name: 'submit_profile_data',
      result: { name: 'Ada' },
    });
    expect(parts.some((part) => part.type.startsWith('text-'))).toBe(false);
  });

  it('can run constrained typed decisions through a Pi submit tool', async () => {
    let requests = 0;
    let decisionSchema: unknown;
    const streamFn: StreamFn = (_model, context) => {
      requests += 1;
      decisionSchema = context.tools?.find((tool) => tool.name === '__submit_structured_decision')?.parameters;
      return toolCallStream([
        {
          id: 'decision-1',
          name: '__submit_structured_decision',
          arguments: { choice: 'checkout' },
        },
      ]);
    };
    const { session, runStore, runState } = await setupDurableHarness('pi-decide', 'pi-decide-run');
    runState.messages = [{ role: 'user', content: 'something unrelated' }];
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: AI_MODEL,
      controlModel: AI_MODEL,
      emit: () => {},
    });
    const node = decide({
      id: 'cart-decision',
      instructions: 'Choose the next cart step.',
      schema: z.object({ choice: z.string() }),
      decide: () => 'stay',
    });
    node.choices = [
      { id: 'checkout', label: 'Checkout' },
      { id: 'more', label: 'Add another item' },
    ];

    const result = await new PiDriver({
      model: PI_MODEL,
      streamFn,
    }).runStructured(node, ctx);

    expect(requests).toBe(1);
    expect(result).toEqual({ choice: 'checkout' });
    expect(JSON.stringify(decisionSchema)).toContain('__none');
    expect(JSON.stringify(decisionSchema)).toContain('checkout');
  });

  it('retries a Pi structured decision when the model returns prose instead of the submit tool', async () => {
    let requests = 0;
    const streamFn: StreamFn = () => {
      requests += 1;
      return requests === 1
        ? textStream(['I think checkout is best.'])
        : toolCallStream([{
            id: 'decision-retry',
            name: '__submit_structured_decision',
            arguments: { choice: 'checkout' },
          }]);
    };
    const { session, runStore, runState } = await setupDurableHarness('pi-decide-retry', 'pi-decide-retry-run');
    runState.messages = [{ role: 'user', content: 'Choose a route' }];
    const parts: StreamPart[] = [];
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: AI_MODEL,
      controlModel: AI_MODEL,
      emit: (part) => parts.push(part),
    });
    const node = decide({
      id: 'retry-decision',
      instructions: 'Choose the next step.',
      schema: z.object({ choice: z.string() }),
      decide: () => 'stay',
    });

    const result = await new PiDriver({
      model: PI_MODEL,
      streamFn,
    }).runStructured(node, ctx);

    expect(result).toEqual({ choice: 'checkout' });
    expect(requests).toBe(2);
    expect(parts.filter((part) => part.type === 'model-call-start')).toHaveLength(2);
    expect(parts.filter((part) => part.type === 'model-call-end')).toHaveLength(2);
  });

  it('closes structured model-call telemetry when the Pi transport fails', async () => {
    const { session, runStore, runState } = await setupDurableHarness(
      'pi-structured-error',
      'pi-structured-error-run',
    );
    runState.messages = [{ role: 'user', content: 'Choose' }];
    const parts: StreamPart[] = [];
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: AI_MODEL,
      controlModel: AI_MODEL,
      emit: (part) => parts.push(part),
    });
    const node = decide({
      id: 'broken-decision',
      instructions: 'Choose.',
      schema: z.object({ choice: z.string() }),
      decide: () => 'stay',
    });

    await expect(new PiDriver({
      model: PI_MODEL,
      streamFn: () => { throw new Error('structured transport unavailable'); },
    }).runStructured(node, ctx)).rejects.toThrow('structured transport unavailable');
    expect(parts.filter((part) => part.type === 'model-call-start')).toHaveLength(1);
    expect(parts.filter((part) => part.type === 'model-call-end')).toHaveLength(1);
    expect(parts.find((part) => part.type === 'model-call-end')?.payload).toMatchObject({
      finishReason: 'error',
    });
  });

  it('bounds structured submit retries and fails explicitly when the model never submits', async () => {
    let requests = 0;
    const streamFn: StreamFn = () => {
      requests += 1;
      return textStream([`prose ${requests}`]);
    };
    const { session, runStore, runState } = await setupDurableHarness(
      'pi-submit-exhausted',
      'pi-submit-exhausted-run',
    );
    runState.messages = [{ role: 'user', content: 'Choose' }];
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: AI_MODEL,
      controlModel: AI_MODEL,
      emit: () => {},
    });
    const node = decide({
      id: 'missing-submit',
      instructions: 'Choose.',
      schema: z.object({ choice: z.string() }),
      decide: () => 'stay',
    });

    await expect(new PiDriver({
      model: PI_MODEL,
      streamFn,
    }).runStructured(node, ctx)).rejects.toThrow(/did not call __submit_structured_decision/);
    expect(requests).toBe(3);
  });

  it('returns host control out of band and does not start a second Pi request', async () => {
    const enterFlow = defineTool({
      name: 'enter_flow',
      description: 'Enter checkout',
      input: z.object({ flowName: z.string(), reason: z.string() }),
      async execute(args) {
        return { __enterFlow: true as const, ...args };
      },
    });
    let requests = 0;
    const streamFn: StreamFn = () => {
      requests += 1;
      return toolCallStream([
        {
          id: 'enter-1',
          name: 'enter_flow',
          arguments: { flowName: 'checkout', reason: 'user asked' },
        },
      ]);
    };
    const { session, runStore, runState } = await setupDurableHarness('pi-control', 'pi-control-run');
    runState.messages = [{ role: 'user', content: 'Check out' }];
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: AI_MODEL,
      emit: () => {},
    });
    const resolved = resolveReplyNode(reply({ id: 'host', instructions: 'Route.' }), {});
    resolved.localTools = { enter_flow: enterFlow };
    const result = await new PiDriver({ model: PI_MODEL, streamFn }).runAgentTurn(resolved, ctx);

    expect(requests).toBe(1);
    expect(result.text).toBe('');
    expect(result.control).toEqual({
      type: 'enterFlow',
      flowName: 'checkout',
      reason: 'user asked',
    });
  });

  it('keeps approval suspension out of Pi tool results and user-visible errors', async () => {
    const charge = defineTool({
      name: 'charge_card',
      description: 'Charge a card',
      input: z.object({ cents: z.number().int() }),
      needsApproval: true,
      async execute(args) {
        return { charged: args.cents };
      },
    });
    const streamFn: StreamFn = () => toolCallStream([
      { id: 'charge-1', name: 'charge_card', arguments: { cents: 500 } },
    ]);
    const parts: StreamPart[] = [];
    const { session, runStore, runState } = await setupDurableHarness('pi-approval', 'pi-approval-run');
    runState.messages = [{ role: 'user', content: 'Charge it' }];
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: AI_MODEL,
      emit: (part) => parts.push(part),
    });
    const resolved = resolveReplyNode(reply({ id: 'charge', instructions: 'Charge when asked.' }), {});
    resolved.localTools = { charge_card: charge };

    await expect(
      new PiDriver({ model: PI_MODEL, streamFn }).runAgentTurn(resolved, ctx),
    ).rejects.toHaveProperty('name', 'SuspendError');
    expect(parts.some((part) => part.type === 'paused')).toBe(true);
    expect(parts.some((part) => part.type === 'error')).toBe(false);
    expect(parts.some((part) => part.type === 'tool-result')).toBe(false);
    expect(runState.waitingFor?.operation?.toolCallId).toBe('charge-1');
  });
});
