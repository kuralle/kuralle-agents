import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { defineFlow, action } from '../../src/types/flow.js';
import { rehydrateFlow } from '../../src/flows/definition/rehydrate.js';
import { digestForLiveFlow, flowDigest } from '../../src/flows/definition/digest.js';
import { sampleFlowDefinition } from '../../src/flows/definition/testing.js';
import { MemoryFlowDefinitionsStore } from '../../src/flows/definition/stores/MemoryFlowDefinitionsStore.js';
import type { FlowDefinition } from '../../src/flows/definition/types.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import { EFFECT_KEY_VERSION } from '../../src/runtime/durable/effectKeyVersion.js';
import { captureFlowPin, clearFlowPin, FlowDriftError } from '../../src/runtime/durable/flowPin.js';
import { pushFlowPark } from '../../src/flow/collectDigression.js';
import { readSessionDurableRuns, runKind, type RunState } from '../../src/runtime/durable/types.js';
import { setupDurableHarness, stubModel, makeRunState, makeTestSession } from './helpers.js';
import type { ChannelDriver } from '../../src/types/channel.js';
import type { StreamPart, TurnHandle } from '../../src/types/stream.js';

const parkingDriver: ChannelDriver = {
  async runAgentTurn() {
    return { text: '', toolResults: [] };
  },
  async awaitUser() {
    return { type: 'message', input: '' };
  },
};

function enterThenParkDriver(flowName: string): ChannelDriver {
  let turns = 0;
  return {
    async runAgentTurn(node) {
      turns += 1;
      if (turns === 1 && 'enter_flow' in (node.tools ?? {})) {
        return {
          text: '',
          toolResults: [
            {
              name: 'enter_flow',
              args: { flowName, reason: 'test' },
              result: { __enterFlow: true, flowName },
            },
          ],
          control: { type: 'enterFlow', flowName },
        };
      }
      return { text: '', toolResults: [] };
    },
    async awaitUser() {
      return { type: 'message', input: '' };
    },
  };
}

function intakeDef(nodeId: string, description = 'Collect a name'): FlowDefinition {
  return {
    name: 'intake',
    description,
    start: nodeId,
    nodes: [
      {
        kind: 'collect',
        id: nodeId,
        schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        ask: 'What is your name?',
        next: { end: 'done' },
      },
    ],
  };
}

function chargeDef(description: string): FlowDefinition {
  return {
    name: 'charge',
    description,
    start: 'act',
    nodes: [{ kind: 'action', id: 'act', tool: 'charge', args: { amount: { value: 10 } }, next: { end: 'done' } }],
  };
}

async function collectTurn(handle: TurnHandle): Promise<{ parts: StreamPart[]; text: string; runId: string }> {
  const parts: StreamPart[] = [];
  for await (const part of handle.events) parts.push(part);
  const result = await handle;
  return { parts, text: result.text, runId: result.runId ?? (await handle.runId) };
}

async function ctxFor(runState: RunState, session: Awaited<ReturnType<typeof setupDurableHarness>>['session'], runStore: Awaited<ReturnType<typeof setupDurableHarness>>['runStore']) {
  return createRunContext({
    session,
    runState,
    runStore,
    steps: await runStore.getSteps(runState.runId),
    toolExecutor: new CoreToolExecutor({ tools: {} }),
    model: stubModel,
    emit: () => {},
  });
}

describe('digestForLiveFlow', () => {
  it('hashes a rehydrated definition via flowDigest of the stash', async () => {
    const def = sampleFlowDefinition({ name: 'refund', description: 'v1' });
    const flow = rehydrateFlow(def, { tools: () => undefined });
    expect(await digestForLiveFlow(flow)).toBe(await flowDigest(def));
  });

  it('falls back to code:<name> for a code-authored flow', async () => {
    const done = action({ id: 'done', run: async () => ({ end: 'done' }) });
    const flow = defineFlow({
      name: 'local-charge',
      description: 'code',
      start: done,
      nodes: [done],
    });
    expect(await digestForLiveFlow(flow)).toBe('code:local-charge');
  });

  it('differs across stored redefinitions of the same name', async () => {
    const v1 = rehydrateFlow(intakeDef('ask-name', 'v1'), { tools: () => undefined });
    const v2 = rehydrateFlow(intakeDef('ask-email', 'v2'), { tools: () => undefined });
    expect(await digestForLiveFlow(v1)).not.toBe(await digestForLiveFlow(v2));
  });

  it('throws when a definition-origin flow has no stashed definition', async () => {
    const flow = rehydrateFlow(intakeDef('ask-name'), { tools: () => undefined });
    const stripped = { ...flow };
    await expect(digestForLiveFlow(stripped)).rejects.toThrow(/no stashed definition/);
  });

  it('computes sha256 once per Flow object', async () => {
    const flow = rehydrateFlow(intakeDef('ask-name'), { tools: () => undefined });
    const orig = crypto.subtle.digest.bind(crypto.subtle);
    let calls = 0;
    Object.defineProperty(crypto.subtle, 'digest', {
      configurable: true,
      value: (...args: Parameters<typeof orig>) => {
        calls += 1;
        return orig(...args);
      },
    });
    try {
      await digestForLiveFlow(flow);
      const afterFirst = calls;
      expect(afterFirst).toBeGreaterThan(0);
      await digestForLiveFlow(flow);
      expect(calls).toBe(afterFirst);
    } finally {
      Object.defineProperty(crypto.subtle, 'digest', {
        configurable: true,
        value: orig,
      });
    }
  });
});

describe('flow digest pin on resume', () => {
  it('throws FlowDriftError with both digests when a parked collect is redefined with a renamed node', async () => {
    const v1 = rehydrateFlow(intakeDef('ask-name'), { tools: () => undefined });
    const { session, runStore, runState } = await setupDurableHarness('drift-sess', 'drift-run');
    const parked = await runFlow(v1, runState, parkingDriver, await ctxFor(runState, session, runStore));
    expect(parked).toEqual({ kind: 'awaitingUser' });
    expect(runState.activeNode).toBe('ask-name');
    const stamped = runState.flowDigest;
    if (typeof stamped !== 'string') throw new Error('expected flowDigest stamp');
    expect(stamped).toBe(await digestForLiveFlow(v1));

    const v2 = rehydrateFlow(intakeDef('ask-email'), { tools: () => undefined });
    const actual = await digestForLiveFlow(v2);
    try {
      await runFlow(v2, runState, parkingDriver, await ctxFor(runState, session, runStore));
      throw new Error('expected FlowDriftError');
    } catch (error) {
      if (!(error instanceof FlowDriftError)) throw error;
      expect(error.runId).toBe('drift-run');
      expect(error.flowName).toBe('intake');
      expect(error.parkedNode).toBe('ask-name');
      expect(error.expectedDigest).toBe(stamped);
      expect(error.actualDigest).toBe(actual);
      expect(error.recovery).toEqual(['restart', 'abandon']);
      expect(error.message).not.toMatch(/Unknown active node/);
    }
  });

  it('throws FlowDriftError when a parked collect keeps its node id but changes ask/schema', async () => {
    const v1 = rehydrateFlow(intakeDef('ask-name', 'v1'), { tools: () => undefined });
    const { session, runStore, runState } = await setupDurableHarness(
      'same-node-sess',
      'same-node-run',
    );
    await runFlow(v1, runState, parkingDriver, await ctxFor(runState, session, runStore));
    expect(runState.activeNode).toBe('ask-name');
    const stamped = runState.flowDigest;
    if (typeof stamped !== 'string') throw new Error('expected flowDigest stamp');

    const v2Def: FlowDefinition = {
      name: 'intake',
      description: 'Collect an email',
      start: 'ask-name',
      nodes: [
        {
          kind: 'collect',
          id: 'ask-name',
          schema: {
            type: 'object',
            properties: { email: { type: 'string' } },
            required: ['email'],
          },
          ask: 'What is your email?',
          next: { end: 'done' },
        },
      ],
    };
    const v2 = rehydrateFlow(v2Def, { tools: () => undefined });
    try {
      await runFlow(v2, runState, parkingDriver, await ctxFor(runState, session, runStore));
      throw new Error('expected FlowDriftError');
    } catch (error) {
      if (!(error instanceof FlowDriftError)) throw error;
      expect(error.parkedNode).toBe('ask-name');
      expect(error.expectedDigest).toBe(stamped);
      expect(error.actualDigest).toBe(await digestForLiveFlow(v2));
      expect(error.message).not.toMatch(/Unknown active node/);
    }
  });

  it('resumes a legacy parked run that has no flowDigest against the same definition', async () => {
    const flow = rehydrateFlow(intakeDef('ask-name'), { tools: () => undefined });
    const { session, runStore, runState } = await setupDurableHarness('legacy-sess', 'legacy-run');
    await runFlow(flow, runState, parkingDriver, await ctxFor(runState, session, runStore));
    expect(runState.activeNode).toBe('ask-name');
    runState.flowDigest = undefined;
    runState.flowRef = undefined;
    await runStore.putRunState(runState);

    const again = await runFlow(
      flow,
      (await runStore.getRunState(runState.runId))!,
      parkingDriver,
      await ctxFor((await runStore.getRunState(runState.runId))!, session, runStore),
    );
    expect(again).toEqual({ kind: 'awaitingUser' });
  });

  it('parks a dynamic flow via addDynamicFlows, then FlowDriftError on replace with a renamed node', async () => {
    const agent = defineAgent({ id: 'clerk', instructions: 'Help.', model: stubModel });
    const store = new MemoryFlowDefinitionsStore();
    const sessionStore = new MemoryStore();
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      defaultModel: stubModel,
      sessionStore,
      flowDefinitionsStore: store,
    });
    await runtime.addDynamicFlows([intakeDef('ask-name')], { agentId: agent.id });

    let turns = 0;
    const driver: ChannelDriver = {
      async runAgentTurn(node) {
        turns += 1;
        if (turns === 1 && 'enter_flow' in (node.tools ?? {})) {
          return {
            text: '',
            toolResults: [
              {
                name: 'enter_flow',
                args: { flowName: 'intake', reason: 'test' },
                result: { __enterFlow: true, flowName: 'intake' },
              },
            ],
            control: { type: 'enterFlow', flowName: 'intake' },
          };
        }
        return { text: '', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: '' };
      },
    };

    await collectTurn(runtime.run({ sessionId: 'dyn-drift', input: 'start', driver }));
    const runStore = new SessionRunStore(sessionStore, 'dyn-drift');
    const parked = await runStore.getRunState('dyn-drift');
    expect(parked?.activeNode).toBe('ask-name');
    const stamped = parked?.flowDigest;
    if (typeof stamped !== 'string') throw new Error('expected flowDigest stamp');
    expect(parked?.flowRef?.versionId).toBe((await store.getActive('intake'))?.versionId);

    await runtime.addDynamicFlows([intakeDef('ask-email')], { agentId: agent.id, replace: true });

    try {
      await collectTurn(runtime.run({ sessionId: 'dyn-drift', input: 'resume', driver }));
      throw new Error('expected FlowDriftError');
    } catch (error) {
      if (!(error instanceof FlowDriftError)) throw error;
      expect(error.expectedDigest).toBe(stamped);
      expect(error.actualDigest).toBe(
        await digestForLiveFlow(rehydrateFlow(intakeDef('ask-email'), { tools: () => undefined })),
      );
      expect(error.parkedNode).toBe('ask-name');
      expect(error.recovery).toEqual(['restart', 'abandon']);
    }
  });

  it('throws FlowDriftError on pop when the parked parent was replaced', async () => {
    const hold = action({
      id: 'hold',
      run: async (_state, ctx) => {
        await ctx.signal('child-hold', { schema: z.object({}) });
        return { end: 'done' };
      },
    });
    const child = defineFlow({
      name: 'child',
      description: 'nested child',
      start: hold,
      nodes: [hold],
    });
    const agent = defineAgent({
      id: 'clerk',
      instructions: 'Help.',
      model: stubModel,
      flows: [child],
    });
    const store = new MemoryFlowDefinitionsStore();
    const sessionStore = new MemoryStore();
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      defaultModel: stubModel,
      sessionStore,
      flowDefinitionsStore: store,
    });
    await runtime.addDynamicFlows([intakeDef('ask-name', 'parent-v1')], { agentId: agent.id });

    const session = makeTestSession('nested-parent');
    session.currentAgent = agent.id;
    await sessionStore.save(session);
    const runStore = new SessionRunStore(sessionStore, 'nested-parent');
    const seeded = makeRunState('nested-parent', 'nested-parent');
    seeded.activeAgentId = agent.id;
    seeded.activeFlow = 'intake';
    await runStore.initRun(seeded);

    await collectTurn(
      runtime.run({ sessionId: 'nested-parent', input: 'start', driver: parkingDriver }),
    );
    const parkedParent = (await runStore.getRunState('nested-parent'))!;
    expect(parkedParent.activeFlow).toBe('intake');
    expect(parkedParent.activeNode).toBe('ask-name');
    const parentStamp = parkedParent.flowDigest;
    const parentFlow = parkedParent.activeFlow;
    const parentNode = parkedParent.activeNode;
    if (typeof parentStamp !== 'string' || !parentFlow || !parentNode) {
      throw new Error('expected parent flowDigest stamp and parked node');
    }

    pushFlowPark(parkedParent, {
      flow: parentFlow,
      node: parentNode,
      state: parkedParent.flowFrame?.state ?? {},
      ...captureFlowPin(parkedParent),
    });
    parkedParent.activeFlow = 'child';
    parkedParent.activeNode = undefined;
    clearFlowPin(parkedParent);
    await runStore.putRunState(parkedParent);

    await collectTurn(runtime.run({ sessionId: 'nested-parent', input: 'go', driver: parkingDriver }));
    const parkedChild = (await runStore.getRunState('nested-parent'))!;
    expect(parkedChild.activeFlow).toBe('child');
    expect(parkedChild.waitingFor?.signalName).toBe('child-hold');

    await runtime.addDynamicFlows([intakeDef('ask-name', 'parent-v2')], {
      agentId: agent.id,
      replace: true,
    });

    try {
      await collectTurn(
        runtime.run({
          sessionId: 'nested-parent',
          signalDelivery: {
            signalId: 'sig-child-hold',
            requestId: parkedChild.waitingFor!.requestId,
            name: 'child-hold',
            actor: { id: 'test', type: 'user' },
            payload: {},
          },
          driver: parkingDriver,
        }),
      );
      throw new Error('expected FlowDriftError');
    } catch (error) {
      if (!(error instanceof FlowDriftError)) throw error;
      expect(error.flowName).toBe('intake');
      expect(error.parkedNode).toBe('ask-name');
      expect(error.expectedDigest).toBe(parentStamp);
    }
  });

  it('does not execute a parked approval when the dynamic flow drifted', async () => {
    const executions = { count: 0 };
    const charge = defineTool({
      name: 'charge',
      description: 'Charge',
      input: z.object({ amount: z.number() }),
      execute: async () => {
        executions.count += 1;
        return { charged: true };
      },
    });
    const gated = (description: string, amount: number): FlowDefinition => ({
      name: 'charge',
      description,
      start: 'act',
      nodes: [
        {
          kind: 'action',
          id: 'act',
          tool: 'charge',
          approval: true,
          args: { amount: { value: amount } },
          next: { end: 'done' },
        },
      ],
    });
    const agent = defineAgent({
      id: 'clerk',
      instructions: 'Help.',
      model: stubModel,
      tools: { charge },
    });
    const store = new MemoryFlowDefinitionsStore();
    const sessionStore = new MemoryStore();
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      defaultModel: stubModel,
      sessionStore,
      flowDefinitionsStore: store,
    });
    await runtime.addDynamicFlows([gated('v1', 10)], { agentId: agent.id });

    const driver = enterThenParkDriver('charge');
    await collectTurn(runtime.run({ sessionId: 'approval-drift', input: 'start', driver }));
    const runStore = new SessionRunStore(sessionStore, 'approval-drift');
    const paused = (await runStore.getRunState('approval-drift'))!;
    expect(paused.waitingFor?.signalName).toBe('__approval');
    expect(paused.activeNode).toBe('act');
    expect(executions.count).toBe(0);

    await runtime.addDynamicFlows([gated('v2', 99)], { agentId: agent.id, replace: true });

    try {
      await collectTurn(
        runtime.run({
          sessionId: 'approval-drift',
          signalDelivery: {
            signalId: 'sig-approval-drift',
            requestId: paused.waitingFor!.requestId,
            name: '__approval',
            actor: { id: 'mgr', type: 'user' },
            decision: 'approve',
          },
          driver,
        }),
      );
      throw new Error('expected FlowDriftError');
    } catch (error) {
      if (!(error instanceof FlowDriftError)) throw error;
      expect(error.parkedNode).toBe('act');
      expect(executions.count).toBe(0);
    }
  });
});

describe('effect keys namespaced by flow@digest', () => {
  it('a v1 journal does not re-execute when resumed after digest pinning', async () => {
    const executions = { count: 0 };
    const charge = defineTool({
      name: 'charge',
      description: 'Charge',
      input: z.object({ amount: z.number() }),
      execute: async () => {
        executions.count += 1;
        return { n: executions.count };
      },
    });
    const tools = (id: string) => (id === 'charge' ? charge : undefined);
    const flow = rehydrateFlow(chargeDef('v1'), { tools });
    const sessionId = 'v1-journal-sess';
    const { session, memoryStore, runStore, runState } = await setupDurableHarness(
      sessionId,
      sessionId,
    );
    runState.activeFlow = 'charge';
    runState.effectKeyVersion = 1;
    await runStore.putRunState(runState);

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: await runStore.getSteps(runState.runId),
      toolExecutor: new CoreToolExecutor({ tools: { charge } }),
      model: stubModel,
      emit: () => {},
    });
    ctx.resetCallsites();
    await ctx.tool('charge', { amount: 10 });
    expect(executions.count).toBe(1);
    const seeded = (await runStore.getRunState(runState.runId))!;
    expect(seeded.effectKeyVersion).toBe(1);
    expect(seeded.flowDigest).toBeUndefined();
    expect(await runStore.getSteps(runState.runId)).toHaveLength(1);
    expect((await runStore.getSteps(runState.runId))[0]?.status).toBe('finished');

    const agent = defineAgent({
      id: 'agent-1',
      instructions: 'Help.',
      model: stubModel,
      flows: [flow],
      tools: { charge },
    });
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      defaultModel: stubModel,
      sessionStore: memoryStore,
    });
    await collectTurn(runtime.run({ sessionId, input: 'resume', driver: parkingDriver }));
    expect(executions.count).toBe(1);
  });

  it('a completed visit of v1 does not replay into a same-named v2 on the same run', async () => {
    const executions = { count: 0 };
    const charge = defineTool({
      name: 'charge',
      description: 'Charge',
      input: z.object({ amount: z.number() }),
      execute: async () => {
        executions.count += 1;
        return { n: executions.count };
      },
    });
    const tools = (id: string) => (id === 'charge' ? charge : undefined);
    const { session, runStore, runState } = await setupDurableHarness('redef-sess', 'redef-run');
    runState.effectKeyVersion = EFFECT_KEY_VERSION;
    await runStore.putRunState(runState);
    const executor = new CoreToolExecutor({ tools: { charge } });
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: executor,
      model: stubModel,
      emit: () => {},
    });

    ctx.resetCallsites();
    const first = await runFlow(
      rehydrateFlow(chargeDef('v1'), { tools }),
      runState,
      parkingDriver,
      ctx,
    );
    expect(first).toEqual({ kind: 'ended', reason: 'done' });
    expect(executions.count).toBe(1);

    runState.activeFlow = undefined;
    runState.activeNode = undefined;
    runState.flowDigest = undefined;
    runState.flowRef = undefined;
    await runStore.putRunState(runState);

    ctx.resetCallsites();
    const second = await runFlow(
      rehydrateFlow(chargeDef('v2'), { tools }),
      runState,
      parkingDriver,
      ctx,
    );
    expect(second).toEqual({ kind: 'ended', reason: 'done' });
    expect(executions.count).toBe(2);
  });
});

describe('kind:flow run identity after digest pin', () => {
  it('stamps flowDigest on a kind:flow mint that parks, and it is in the session map', async () => {
    const flow = rehydrateFlow(intakeDef('ask-name'), { tools: () => undefined });
    const agent = defineAgent({ id: 'clerk', model: stubModel, flows: [flow] });
    const sessionStore = new MemoryStore();
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      defaultModel: stubModel,
      sessionStore,
    });
    const result = await collectTurn(
      runtime.run({ sessionId: 'stamp-sess', kind: 'flow', flowName: 'intake', driver: parkingDriver }),
    );
    const session = (await sessionStore.get('stamp-sess'))!;
    const flowRuns = Object.values(readSessionDurableRuns(session)).filter(
      (persisted) => runKind(persisted.runState) === 'flow',
    );
    expect(flowRuns).toHaveLength(1);
    const persisted = flowRuns[0]!.runState;
    expect(persisted.runId).toBe(result.runId);
    const stamp = persisted.flowDigest;
    if (typeof stamp !== 'string') throw new Error('expected flowDigest stamp');
    expect(stamp).toBe(await digestForLiveFlow(flow));
    expect(persisted.activeNode).toBe('ask-name');
  });
});
