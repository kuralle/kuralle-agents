import { afterEach, describe, expect, it, mock } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { rehydrateFlow } from '../../src/flows/definition/rehydrate.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { TraceRecorder } from '../../src/runtime/TraceRecorder.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import type { ChannelDriver } from '../../src/types/channel.js';
import { defineFlow, reply } from '../../src/types/flow.js';
import type { StreamPart } from '../../src/types/stream.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';

const AUTHORED = 'Your refund of $40 is confirmed.';

const REPLY_SHAPE = new Set([
  'text-start',
  'text-delta',
  'text-end',
  'node-enter',
  'node-exit',
  'flow-enter',
  'flow-end',
  'flow-transition',
]);

function replyShape(parts: StreamPart[]): StreamPart['type'][] {
  return parts.filter((part) => REPLY_SHAPE.has(part.type)).map((part) => part.type);
}

function spyDriver(onTurn?: ChannelDriver['runAgentTurn']): ChannelDriver & { turns: number } {
  const driver = {
    turns: 0,
    async runAgentTurn(node: Parameters<ChannelDriver['runAgentTurn']>[0], ctx: Parameters<ChannelDriver['runAgentTurn']>[1]) {
      driver.turns += 1;
      if (onTurn) return onTurn(node, ctx);
      throw new Error('authored reply must not call the model');
    },
    async awaitUser() {
      return { type: 'message' as const, input: '' };
    },
  };
  return driver;
}

async function runReplyFlow(args: {
  flow: ReturnType<typeof defineFlow>;
  driver: ChannelDriver;
  sessionId: string;
  state?: Record<string, unknown>;
}): Promise<{ parts: StreamPart[]; result: Awaited<ReturnType<typeof runFlow>> }> {
  const { session, runStore, runState } = await setupDurableHarness(args.sessionId, args.sessionId);
  if (args.state) Object.assign(runState.state, args.state);
  const parts: StreamPart[] = [];
  const ctx = await createRunContext({
    session,
    runState,
    runStore,
    steps: [],
    toolExecutor: new CoreToolExecutor({ tools: {} }),
    model: stubModel,
    emit: (part) => parts.push(part),
  });
  const result = await runFlow(args.flow, runState, args.driver, ctx);
  return { parts, result };
}

describe('engine-rendered authored replies', () => {
  it('emits the exact response text with zero model turns (code dialect)', async () => {
    const say = reply({
      id: 'say',
      instructions: 'unused — engine renders',
      response: () => AUTHORED,
      next: () => ({ end: 'done' }),
    });
    const flow = defineFlow({ name: 'refund', description: '', start: say, nodes: [say] });
    const driver = spyDriver();

    const { parts, result } = await runReplyFlow({ flow, driver, sessionId: 'engine-code' });

    expect(result).toEqual({ kind: 'ended', reason: 'done' });
    expect(driver.turns).toBe(0);
    const deltas = parts
      .filter((part): part is Extract<StreamPart, { type: 'text-delta' }> => part.type === 'text-delta')
      .map((part) => part.payload.delta);
    expect(deltas).toEqual([AUTHORED]);
  });

  it('emits the exact template text with zero model turns (definition dialect)', async () => {
    const flow = rehydrateFlow(
      {
        name: 'refund',
        description: '',
        start: 'say',
        nodes: [
          {
            kind: 'reply',
            id: 'say',
            response: { template: AUTHORED },
            next: { end: 'done' },
          },
        ],
      },
      { tools: () => undefined },
    );
    const driver = spyDriver();

    const { parts, result } = await runReplyFlow({
      flow,
      driver,
      sessionId: 'engine-template',
    });

    expect(result).toEqual({ kind: 'ended', reason: 'done' });
    expect(driver.turns).toBe(0);
    const text = parts
      .filter((part): part is Extract<StreamPart, { type: 'text-delta' }> => part.type === 'text-delta')
      .map((part) => part.payload.delta)
      .join('');
    expect(text).toBe(AUTHORED);
  });

  it('preserves text-start/delta/end + node event sequence against a generated reply', async () => {
    const authored = reply({
      id: 'say',
      instructions: 'unused',
      response: () => AUTHORED,
      next: () => ({ end: 'done' }),
    });
    const generated = reply({
      id: 'say',
      instructions: 'Thank the user.',
      next: () => ({ end: 'done' }),
    });
    const authoredFlow = defineFlow({
      name: 'refund',
      description: '',
      start: authored,
      nodes: [authored],
    });
    const generatedFlow = defineFlow({
      name: 'refund',
      description: '',
      start: generated,
      nodes: [generated],
    });

    const authoredRun = await runReplyFlow({
      flow: authoredFlow,
      driver: spyDriver(),
      sessionId: 'shape-authored',
    });
    const generatedDriver = spyDriver(async (_node, ctx) => {
      const id = 'gen';
      ctx.emit({ channel: 'client', type: 'text-start', payload: { id } });
      ctx.emit({ channel: 'client', type: 'text-delta', payload: { id, delta: 'Thanks.' } });
      ctx.emit({ channel: 'client', type: 'text-end', payload: { id } });
      ctx.emit({ channel: 'internal', type: 'turn-end', payload: { rendered: 'model' } });
      return { text: 'Thanks.', toolResults: [] };
    });
    const generatedRun = await runReplyFlow({
      flow: generatedFlow,
      driver: generatedDriver,
      sessionId: 'shape-generated',
    });

    expect(generatedDriver.turns).toBe(1);
    expect(replyShape(authoredRun.parts)).toEqual(replyShape(generatedRun.parts));
    expect(replyShape(authoredRun.parts)).toEqual([
      'flow-enter',
      'node-enter',
      'text-start',
      'text-delta',
      'text-end',
      'flow-end',
    ]);
  });

  it('still runs verify after an authored reply', async () => {
    let verified = 0;
    const say = reply({
      id: 'say',
      instructions: '',
      response: () => AUTHORED,
      verify: {
        check: () => {
          verified += 1;
          return true;
        },
      },
      next: () => ({ end: 'done' }),
    });
    const flow = defineFlow({ name: 'refund', description: '', start: say, nodes: [say] });
    const { result } = await runReplyFlow({
      flow,
      driver: spyDriver(),
      sessionId: 'engine-verify',
    });
    expect(result).toEqual({ kind: 'ended', reason: 'done' });
    expect(verified).toBe(1);
  });

  it('copies turn-end.rendered onto the current node span', () => {
    const recorder = new TraceRecorder({ sessionId: 'span-rendered' });
    recorder.record({ channel: 'internal', type: 'flow-enter', payload: { flow: 'refund' } });
    recorder.record({ channel: 'internal', type: 'node-enter', payload: { nodeName: 'say' } });
    recorder.record({ channel: 'internal', type: 'turn-end', payload: { rendered: 'engine' } });
    recorder.record({ channel: 'internal', type: 'flow-end', payload: { flow: 'refund', reason: 'done' } });
    recorder.record({ channel: 'client', type: 'done', payload: { sessionId: 'span-rendered' } });

    const trace = recorder.finish({ text: AUTHORED, toolResults: [] });
    const node = trace.spans.find((span) => span.kind === 'node' && span.attributes.nodeId === 'say');
    expect(node?.attributes.rendered).toBe('engine');
  });
});

describe('engine-rendered replies through Runtime', () => {
  afterEach(() => {
    mock.restore();
  });

  it('authored reply: provider spy is 0 and the node span is rendered=engine', async () => {
    let streamCalls = 0;
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: () => {
          streamCalls += 1;
          throw new Error(`streamText must not run for authored replies (call ${streamCalls})`);
        },
      };
    });

    const say = reply({
      id: 'say',
      instructions: 'unused',
      response: () => AUTHORED,
      next: () => ({ end: 'done' }),
    });
    const flow = defineFlow({ name: 'refund', description: '', start: say, nodes: [say] });
    const agent = defineAgent({
      id: 'clerk',
      instructions: 'Help.',
      model: stubModel,
      flows: [flow],
    });
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      sessionStore: new MemoryStore(),
    });

    const trace = await runtime.runOnce({
      sessionId: 'engine-runtime-authored',
      kind: 'flow',
      flowName: 'refund',
      input: 'go',
    });

    expect(streamCalls).toBe(0);
    expect(trace.answer).toBe(AUTHORED);
    const node = trace.spans.find((span) => span.kind === 'node' && span.attributes.nodeId === 'say');
    expect(node?.attributes.rendered).toBe('engine');
    expect(trace.spans.some((span) => span.kind === 'llm')).toBe(false);
  });

  it('generated reply: provider spy is >0 and the node span is rendered=model', async () => {
    let streamCalls = 0;
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: () => {
          streamCalls += 1;
          return {
            fullStream: (async function* () {
              yield Object.assign({ type: 'text-delta' }, { text: 'Thanks.' });
            })(),
            finishReason: Promise.resolve('stop'),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve([]),
            totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 4, totalTokens: 14 }),
          };
        },
      };
    });

    const say = reply({
      id: 'say',
      instructions: 'Thank the user in one sentence.',
      next: () => ({ end: 'done' }),
    });
    const flow = defineFlow({ name: 'thanks', description: '', start: say, nodes: [say] });
    const agent = defineAgent({
      id: 'clerk',
      instructions: 'Help.',
      model: stubModel,
      flows: [flow],
    });
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      sessionStore: new MemoryStore(),
    });

    const trace = await runtime.runOnce({
      sessionId: 'engine-runtime-generated',
      kind: 'flow',
      flowName: 'thanks',
      input: 'go',
    });

    expect(streamCalls).toBeGreaterThan(0);
    expect(trace.answer).toBe('Thanks.');
    const node = trace.spans.find((span) => span.kind === 'node' && span.attributes.nodeId === 'say');
    expect(node?.attributes.rendered).toBe('model');
  });
});
