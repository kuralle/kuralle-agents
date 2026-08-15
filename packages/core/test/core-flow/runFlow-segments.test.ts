import { describe, expect, it } from 'bun:test';
import { rehydrateFlow } from '../../src/flows/definition/rehydrate.js';
import type { FlowDefinition } from '../../src/flows/definition/types.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { TraceRecorder } from '../../src/runtime/TraceRecorder.js';
import { CoreToolExecutor, defineTool } from '../../src/tools/effect/index.js';
import { RecoverableToolError } from '../../src/tools/effect/errors.js';
import type { ChannelDriver } from '../../src/types/channel.js';
import type { AnyTool } from '../../src/types/effectTool.js';
import type { StreamPart } from '../../src/types/stream.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';

function spyDriver(): ChannelDriver & { turns: number; prompts: string[] } {
  const driver = {
    turns: 0,
    prompts: [] as string[],
    async runAgentTurn(node: Parameters<ChannelDriver['runAgentTurn']>[0]) {
      driver.turns += 1;
      driver.prompts.push(node.prompt);
      return { text: `turn-${driver.turns}`, toolResults: [] };
    },
    async awaitUser() {
      return { type: 'message' as const, input: 'ok' };
    },
    async runStructured() {
      return { choice: 'go' };
    },
    async runExtraction() {
      return { text: '', toolResults: [] };
    },
  };
  return driver;
}

async function runDef(
  def: FlowDefinition,
  args: {
    sessionId: string;
    tools?: Record<string, AnyTool>;
    driver?: ChannelDriver;
    prepare?: (runState: Awaited<ReturnType<typeof setupDurableHarness>>['runState']) => void;
  },
) {
  const tools = args.tools ?? {};
  const flow = rehydrateFlow(def, { tools: (id) => tools[id] });
  const driver = args.driver ?? spyDriver();
  const { session, runStore, runState } = await setupDurableHarness(args.sessionId, args.sessionId);
  args.prepare?.(runState);
  const recorder = new TraceRecorder({ sessionId: args.sessionId });
  const parts: StreamPart[] = [];
  const ctx = await createRunContext({
    session,
    runState,
    runStore,
    steps: [],
    toolExecutor: new CoreToolExecutor({ tools }),
    model: stubModel,
    emit: (part) => {
      recorder.record(part);
      parts.push(part);
    },
  });
  const result = await runFlow(flow, runState, driver, ctx);
  const trace = recorder.finish({ text: '', toolResults: [] });
  const steps = await runStore.getSteps(runState.runId);
  return { flow, driver, result, parts, trace, steps, runState };
}

const threeGenerate: FlowDefinition = {
  name: 'three-gen',
  description: '',
  start: 'a',
  nodes: [
    { kind: 'reply', id: 'a', generate: true, instructions: 'Say one.', next: { goto: 'b' } },
    { kind: 'reply', id: 'b', generate: true, instructions: 'Say two.', next: { goto: 'c' } },
    { kind: 'reply', id: 'c', generate: true, instructions: 'Say three.', next: { end: 'done' } },
  ],
};

describe('runFlow segment batching', () => {
  it('three consecutive generate replies: one model call, three node spans', async () => {
    const { driver, result, trace } = await runDef(threeGenerate, { sessionId: 'seg-gen-3' });
    expect(result).toEqual({ kind: 'ended', reason: 'done' });
    expect((driver as ReturnType<typeof spyDriver>).turns).toBe(1);
    expect((driver as ReturnType<typeof spyDriver>).prompts[0]).toContain('Say one.');
    expect((driver as ReturnType<typeof spyDriver>).prompts[0]).toContain('Say two.');
    expect((driver as ReturnType<typeof spyDriver>).prompts[0]).toContain('Say three.');
    expect(
      trace.spans.filter((span) => span.kind === 'node').map((span) => span.attributes.nodeId),
    ).toEqual(['a', 'b', 'c']);
  });

  it('three consecutive actions: zero model calls, three journaled steps, three node spans', async () => {
    const order: string[] = [];
    const tools = {
      t1: defineTool({ name: 't1', description: 't1', execute: async () => { order.push('t1'); return { n: 1 }; } }),
      t2: defineTool({ name: 't2', description: 't2', execute: async () => { order.push('t2'); return { n: 2 }; } }),
      t3: defineTool({ name: 't3', description: 't3', execute: async () => { order.push('t3'); return { n: 3 }; } }),
    };
    const { driver, result, trace, steps } = await runDef(
      {
        name: 'three-act',
        description: '',
        start: 'a',
        nodes: [
          { kind: 'action', id: 'a', tool: 't1', next: { goto: 'b' } },
          { kind: 'action', id: 'b', tool: 't2', next: { goto: 'c' } },
          { kind: 'action', id: 'c', tool: 't3', next: { end: 'done' } },
        ],
      },
      { sessionId: 'seg-act-3', tools, driver: spyDriver() },
    );
    expect(result).toEqual({ kind: 'ended', reason: 'done' });
    expect((driver as ReturnType<typeof spyDriver>).turns).toBe(0);
    expect(order).toEqual(['t1', 't2', 't3']);
    expect(steps.filter((step) => step.kind === 'tool')).toHaveLength(3);
    expect(
      trace.spans.filter((span) => span.kind === 'node').map((span) => span.attributes.nodeId),
    ).toEqual(['a', 'b', 'c']);
  });

  it('a decide between generate replies is not batched; the decide runs per-node', async () => {
    const driver = spyDriver();
    const { result, trace } = await runDef(
      {
        name: 'split-decide',
        description: '',
        start: 'a',
        nodes: [
          { kind: 'reply', id: 'a', generate: true, instructions: 'A', next: { goto: 'pick' } },
          {
            kind: 'decide',
            id: 'pick',
            schema: { type: 'object', properties: { choice: { type: 'string' } } },
            otherwise: { goto: 'b' },
          },
          { kind: 'reply', id: 'b', generate: true, instructions: 'B', next: { end: 'done' } },
        ],
      },
      { sessionId: 'seg-decide', driver },
    );
    expect(result).toEqual({ kind: 'ended', reason: 'done' });
    expect(driver.turns).toBe(2);
    expect(
      trace.spans.filter((span) => span.kind === 'node').map((span) => span.attributes.nodeId),
    ).toEqual(['a', 'pick', 'b']);
  });

  it('an approval action splits an action chain so the boundary runs per-node', async () => {
    const order: string[] = [];
    const tools = {
      t1: defineTool({ name: 't1', description: 't1', execute: async () => { order.push('t1'); return {}; } }),
      gate: defineTool({ name: 'gate', description: 'gate', execute: async () => { order.push('gate'); return {}; } }),
      t2: defineTool({ name: 't2', description: 't2', execute: async () => { order.push('t2'); return {}; } }),
    };
    await expect(
      runDef(
        {
          name: 'split-approval',
          description: '',
          start: 'a',
          nodes: [
            { kind: 'action', id: 'a', tool: 't1', next: { goto: 'gate' } },
            { kind: 'action', id: 'gate', tool: 'gate', approval: true, next: { goto: 'b' } },
            { kind: 'action', id: 'b', tool: 't2', next: { end: 'done' } },
          ],
        },
        { sessionId: 'seg-approval', tools },
      ),
    ).rejects.toThrow(/suspended waiting for __approval/);
    expect(order).toEqual(['t1']);
  });

  it('a failing tool at node 2 of 3 surfaces the same recoverable re-ask as the unsegmented path', async () => {
    const createWorkOrder = defineTool({
      name: 'create_work_order',
      description: 'create',
      execute: async () => {
        throw new RecoverableToolError("Unknown unit '12B'");
      },
    });
    const ok = defineTool({ name: 'ok', description: 'ok', execute: async () => ({ ok: true }) });
    const { result, runState, parts } = await runDef(
      {
        name: 'mid-err',
        description: '',
        start: 'gather',
        nodes: [
          {
            kind: 'collect',
            id: 'gather',
            schema: { type: 'object', properties: { unitId: { type: 'string' } }, required: ['unitId'] },
            required: ['unitId'],
            ask: 'Which unit?',
            next: { goto: 'a' },
          },
          { kind: 'action', id: 'a', tool: 'ok', next: { goto: 'b' } },
          { kind: 'action', id: 'b', tool: 'create_work_order', next: { goto: 'c' } },
          { kind: 'action', id: 'c', tool: 'ok', next: { end: 'done' } },
        ],
      },
      {
        sessionId: 'seg-mid-err',
        tools: { create_work_order: createWorkOrder, ok },
        prepare: (runState) => {
          runState.activeFlow = 'mid-err';
          runState.activeNode = 'gather';
          runState.flowFrame = { flow: 'mid-err', state: { __collect_gather: { unitId: '12B' } } };
        },
      },
    );
    expect(result).toEqual({ kind: 'awaitingUser' });
    expect(runState.activeNode).toBe('gather');
    expect(parts.some((part) => part.type === 'text-delta' && /Which unit/.test(part.payload.delta))).toBe(true);
  });
});
