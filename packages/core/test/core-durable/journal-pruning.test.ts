import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { action, collect, defineFlow } from '../../src/types/flow.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { openRun } from '../../src/runtime/openRun.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { readSessionDurableRuns, runKind } from '../../src/runtime/durable/types.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import { consumeAllPendingUserInput } from '../../src/runtime/channels/inputBuffer.js';
import { buildCtx, stubModel } from './helpers.js';
import type { ChannelDriver } from '../../src/types/channel.js';

const defaultAgentId = 'agent-1';

function intakeDriver(): ChannelDriver {
  return {
    async runAgentTurn(_node, ctx) {
      const last = ctx.runState.messages.filter((m) => m.role === 'user').at(-1);
      const text = typeof last?.content === 'string' ? last.content : '';
      if (text === 'Ada') {
        return {
          text: '',
          toolResults: [{ name: 'submit_intake_data', args: { name: 'Ada' }, result: { name: 'Ada' } }],
        };
      }
      if (text === 'Paris') {
        return {
          text: '',
          toolResults: [{ name: 'submit_intake_data', args: { city: 'Paris' }, result: { city: 'Paris' } }],
        };
      }
      return { text: 'Need name and city.', toolResults: [] };
    },
    async awaitUser(ctx) {
      const input = consumeAllPendingUserInput(ctx.session, ctx.runState) ?? '';
      return { type: 'message', input };
    },
  };
}

describe('flow-run journal is not pruned across collect turns', () => {
  it('retains journaled steps and does not re-execute finished effects across three user turns', async () => {
    const sessionId = 'flow-journal-sess';
    const store = new MemoryStore();
    const executions = { count: 0 };
    const charge = defineTool({
      name: 'charge',
      description: 'Charge once',
      input: z.object({ amount: z.number() }),
      execute: async () => {
        executions.count += 1;
        return { charged: true, n: executions.count };
      },
    });

    const intake = collect({
      id: 'intake',
      schema: z.object({ name: z.string().min(1), city: z.string().min(1) }),
      required: ['name', 'city'],
      maxTurns: 5,
      instructions: () => 'Collect name and city.',
      onComplete: () => ({ end: 'done' }),
    });
    const chargeThenAsk = action({
      id: 'charge',
      run: async (_state, ctx) => {
        await ctx.tool('charge', { amount: 10 });
        return intake;
      },
    });
    const flow = defineFlow({
      name: 'charge-intake',
      description: 'Charge then collect',
      start: chargeThenAsk,
      nodes: [chargeThenAsk, intake],
    });
    const agent = defineAgent({
      id: defaultAgentId,
      model: stubModel,
      flows: [flow],
      tools: { charge },
    });
    const driver = intakeDriver();
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId,
      sessionStore: store,
      defaultModel: stubModel,
    });

    await runtime.run({
      sessionId,
      kind: 'flow',
      flowName: 'charge-intake',
      driver,
    });
    const session = (await store.get(sessionId))!;
    const flowRuns = Object.values(readSessionDurableRuns(session)).filter(
      (persisted) => runKind(persisted.runState) === 'flow',
    );
    expect(flowRuns).toHaveLength(1);
    const runId = flowRuns[0]!.runState.runId;

    expect(executions.count).toBe(1);
    const runStore = new SessionRunStore(store, sessionId);
    const afterFirst = await runStore.getSteps(runId);
    const chargeSteps = afterFirst.filter((step) => step.name === 'charge');
    expect(chargeSteps).toHaveLength(1);
    expect(chargeSteps[0]!.result).toEqual({ charged: true, n: 1 });
    const firstEpoch = (await runStore.getRunState(runId))?.runEpoch ?? 0;

    await runtime.run({ sessionId, runId, input: 'Ada', driver });
    expect(executions.count).toBe(1);
    const afterSecond = await runStore.getSteps(runId);
    expect(afterSecond.filter((step) => step.name === 'charge')).toHaveLength(1);
    expect((await runStore.getRunState(runId))?.runEpoch ?? 0).toBe(firstEpoch);

    await runtime.run({ sessionId, runId, input: 'Paris', driver });
    expect(executions.count).toBe(1);
    const afterThird = await runStore.getSteps(runId);
    expect(afterThird.filter((step) => step.name === 'charge')).toHaveLength(1);
    expect(afterThird.length).toBeGreaterThanOrEqual(afterFirst.length);
    const finished = await runStore.getRunState(runId);
    expect(finished?.runEpoch ?? 0).toBe(firstEpoch);
    expect(finished?.activeFlow).toBeUndefined();
  });
});

describe('kind:flow run without activeFlow does not prune on a later user turn', () => {
  it('replays the journaled effect instead of re-executing', async () => {
    const sessionId = 'flow-no-active-sess';
    const store = new MemoryStore();
    const executions = { count: 0 };
    const opened = await openRun(
      new Map([[defaultAgentId, defineAgent({ id: defaultAgentId, model: stubModel })]]),
      {
        sessionId,
        defaultAgentId,
        sessionStore: store,
        kind: 'flow',
      },
    );
    expect(opened.runState.activeFlow).toBeUndefined();
    expect(opened.runState.kind).toBe('flow');

    const toolExecutor = {
      execute: async () => {
        executions.count += 1;
        return { n: executions.count };
      },
    };
    const ctx1 = await buildCtx({
      session: opened.session,
      runStore: opened.runStore,
      runState: opened.runState,
      toolExecutor,
    });
    await ctx1.tool('mark', { x: 1 });
    expect(executions.count).toBe(1);

    const resumed = await openRun(
      new Map([[defaultAgentId, defineAgent({ id: defaultAgentId, model: stubModel })]]),
      {
        sessionId,
        defaultAgentId,
        sessionStore: store,
        runId: opened.runState.runId,
        input: 'continue',
      },
    );
    expect(resumed.runState.runEpoch ?? 0).toBe(opened.runState.runEpoch ?? 0);
    const steps = await resumed.runStore.getSteps(opened.runState.runId);
    expect(steps.filter((step) => step.name === 'mark')).toHaveLength(1);

    const ctx2 = await buildCtx({
      session: resumed.session,
      runStore: resumed.runStore,
      runState: resumed.runState,
      toolExecutor,
    });
    const replayed = await ctx2.tool('mark', { x: 1 });
    expect(executions.count).toBe(1);
    expect(replayed).toEqual({ n: 1 });
  });
});

describe('conversation-run pruning is unchanged', () => {
  it('a new user turn on the conversation run re-executes the same tool+args', async () => {
    const sessionId = 'conv-prune-sess';
    const store = new MemoryStore();
    const executions = { count: 0 };
    const ping = defineTool({
      name: 'ping',
      description: 'ping',
      input: z.object({ n: z.number() }),
      execute: async () => {
        executions.count += 1;
        return { n: executions.count };
      },
    });
    const driver: ChannelDriver = {
      async runAgentTurn(_node, ctx) {
        await ctx.tool('ping', { n: 1 });
        return { text: 'ok', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: '' };
      },
    };
    const runtime = createRuntime({
      agents: [
        defineAgent({
          id: defaultAgentId,
          model: stubModel,
          instructions: 'ok',
          tools: { ping },
        }),
      ],
      defaultAgentId,
      sessionStore: store,
      defaultModel: stubModel,
    });

    await runtime.run({ sessionId, input: 'one', driver });
    expect(executions.count).toBe(1);
    await runtime.run({ sessionId, input: 'two', driver });
    expect(executions.count).toBe(2);
    const steps = await new SessionRunStore(store, sessionId).getSteps(sessionId);
    const pings = steps.filter((step) => step.name === 'ping');
    expect(pings).toHaveLength(1);
    expect(pings[0]!.epoch).toBe(2);
    expect(pings[0]!.result).toEqual({ n: 2 });
  });
});
