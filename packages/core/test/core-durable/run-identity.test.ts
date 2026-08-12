import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { collect, defineFlow } from '../../src/types/flow.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { mintRunId, openRun } from '../../src/runtime/openRun.js';
import { RunNotFoundError } from '../../src/runtime/durable/RunStore.js';
import { readSessionDurableRuns, runKind } from '../../src/runtime/durable/types.js';
import type { InterruptRequest, RunState, SignalDelivery } from '../../src/runtime/durable/types.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { findUnresumableRuns } from '../../src/runtime/durable/findUnresumableRuns.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import {
  consumeAllPendingUserInput,
  hasPendingUserInput,
} from '../../src/runtime/channels/inputBuffer.js';
import {
  buildCtx,
  makeRunState,
  makeTestSession,
  stubModel,
} from './helpers.js';
import type { ChannelDriver } from '../../src/types/channel.js';
import type { UserInputContent } from '../../src/runtime/userInput.js';

const defaultAgentId = 'agent-1';

function agentsMap() {
  const agent = defineAgent({ id: defaultAgentId, model: stubModel });
  return new Map([[agent.id, agent]]);
}

function openOpts(
  sessionStore: MemoryStore,
  sessionId: string,
  extra: Omit<Parameters<typeof openRun>[1], 'defaultAgentId' | 'sessionStore' | 'sessionId'> = {},
) {
  return {
    sessionId,
    defaultAgentId,
    sessionStore,
    ...extra,
  };
}

function parkedWaitingFor(requestId: string, signalName: string): InterruptRequest {
  return {
    requestId,
    kind: 'signal',
    signalName,
    callsite: '0',
    resumeKey: 'resume-key',
    createdAt: Date.now(),
    deadline: null,
    display: { title: signalName },
    allowedDecisions: ['approve', 'deny'],
    responseSchema: {},
  };
}

function signalFor(run: RunState, name: string): SignalDelivery {
  return {
    signalId: `sig-${run.runId}`,
    requestId: run.waitingFor!.requestId,
    name,
    actor: { id: 'test', type: 'user' },
    decision: 'approve',
  };
}

describe('run identity', () => {
  it('conversation run is keyed by sessionId and stamped conversation', async () => {
    const sessionId = 'conv-sess';
    const store = new MemoryStore();
    const opened = await openRun(agentsMap(), openOpts(store, sessionId, { input: 'hi' }));

    expect(opened.runState.runId).toBe(sessionId);
    expect(runKind(opened.runState)).toBe('conversation');
    expect(opened.runState.kind).toBe('conversation');
  });

  it('two flow runs in one session journal independently', async () => {
    const sessionId = 'two-flow-sess';
    const store = new MemoryStore();
    const agents = agentsMap();

    const first = await openRun(agents, openOpts(store, sessionId, { kind: 'flow' }));
    const second = await openRun(agents, openOpts(store, sessionId, { kind: 'flow' }));

    expect(first.runState.runId).not.toBe(sessionId);
    expect(second.runState.runId).not.toBe(sessionId);
    expect(first.runState.runId).not.toBe(second.runState.runId);
    expect(runKind(first.runState)).toBe('flow');
    expect(runKind(second.runState)).toBe('flow');

    const session = (await store.get(sessionId))!;
    const runs = readSessionDurableRuns(session);
    expect(Object.keys(runs).sort()).toEqual(
      [first.runState.runId, second.runState.runId].sort(),
    );

    const executions: string[] = [];
    const toolExecutor = {
      execute: async ({ name }: { name: string }) => {
        executions.push(`${name}:${executions.length}`);
        return { n: executions.length };
      },
    };

    const ctx1 = await buildCtx({
      session,
      runStore: first.runStore,
      runState: first.runState,
      toolExecutor,
    });
    const ctx2 = await buildCtx({
      session,
      runStore: second.runStore,
      runState: second.runState,
      toolExecutor,
    });

    const result1 = await ctx1.tool('ping', { x: 1 });
    const result2 = await ctx2.tool('ping', { x: 1 });

    expect(result1).toEqual({ n: 1 });
    expect(result2).toEqual({ n: 2 });
    expect(executions).toEqual(['ping:0', 'ping:1']);

    const steps1 = await first.runStore.getSteps(first.runState.runId);
    const steps2 = await second.runStore.getSteps(second.runState.runId);
    expect(steps1).toHaveLength(1);
    expect(steps2).toHaveLength(1);
    expect(steps1[0]!.key).not.toBe(steps2[0]!.key);
    expect(steps1[0]!.result).toEqual({ n: 1 });
    expect(steps2[0]!.result).toEqual({ n: 2 });
  });

  it('legacy session-keyed run without kind still resumes', async () => {
    const sessionId = 'legacy-sess';
    const store = new MemoryStore();
    const session = makeTestSession(sessionId);
    await store.save(session);
    const runStore = new SessionRunStore(store, sessionId);
    const legacy = makeRunState(sessionId, sessionId);
    delete legacy.kind;
    legacy.status = 'paused';
    legacy.waitingFor = parkedWaitingFor('legacy-req', 'continue');
    await runStore.initRun(legacy);

    const opened = await openRun(
      agentsMap(),
      openOpts(store, sessionId, {
        signalDelivery: signalFor(legacy, 'continue'),
      }),
    );

    expect(opened.runState.runId).toBe(sessionId);
    expect(runKind(opened.runState)).toBe('conversation');
    expect(opened.runState.kind).toBe('conversation');
  });

  it('unknown runId fails closed instead of opening the conversation run', async () => {
    const sessionId = 'unknown-run-sess';
    const store = new MemoryStore();
    await openRun(agentsMap(), openOpts(store, sessionId, { input: 'hi' }));

    let thrown: unknown;
    try {
      await openRun(agentsMap(), openOpts(store, sessionId, { runId: 'guessed-run' }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RunNotFoundError);
    expect((thrown as Error).message).toBe('Run not found: guessed-run');

    const conversation = await new SessionRunStore(store, sessionId).getRunState(sessionId);
    expect(conversation?.messages.at(-1)).toEqual({ role: 'user', content: 'hi' });
    const session = (await store.get(sessionId))!;
    expect(Object.keys(readSessionDurableRuns(session))).toEqual([sessionId]);
  });

  it('a runId belonging to another session fails closed', async () => {
    const store = new MemoryStore();
    const agents = agentsMap();
    const victim = await openRun(agents, openOpts(store, 'sess-victim', { kind: 'flow' }));
    await openRun(agents, openOpts(store, 'sess-attacker', { input: 'hi' }));

    await expect(
      openRun(
        agents,
        openOpts(store, 'sess-attacker', { runId: victim.runState.runId }),
      ),
    ).rejects.toBeInstanceOf(RunNotFoundError);

    const attackerSession = (await store.get('sess-attacker'))!;
    expect(readSessionDurableRuns(attackerSession)[victim.runState.runId]).toBeUndefined();
  });

  it('mintRunId uses the supplied uuid source so a journaled mint is stable', () => {
    expect(mintRunId(() => 'journaled-uuid')).toBe('journaled-uuid');
  });

  it('a new flow run can mint through the journaled uuid source', async () => {
    const store = new MemoryStore();
    const opened = await openRun(
      agentsMap(),
      openOpts(store, 'mint-sess', { kind: 'flow', mint: () => 'flow-from-clock' }),
    );
    expect(opened.runState.runId).toBe('flow-from-clock');
    expect(runKind(opened.runState)).toBe('flow');
  });

  it('SignalDelivery.runId resumes that run, not the conversation run', async () => {
    const sessionId = 'signal-addr-sess';
    const store = new MemoryStore();
    const agents = agentsMap();
    await openRun(agents, openOpts(store, sessionId, { input: 'chat' }));
    const flow = await openRun(agents, openOpts(store, sessionId, { kind: 'flow' }));
    flow.runState.status = 'paused';
    flow.runState.waitingFor = parkedWaitingFor('flow-req', 'approve');
    await flow.runStore.putRunState(flow.runState);

    const opened = await openRun(
      agents,
      openOpts(store, sessionId, {
        signalDelivery: { ...signalFor(flow.runState, 'approve'), runId: flow.runState.runId },
      }),
    );

    expect(opened.runState.runId).toBe(flow.runState.runId);
    expect(runKind(opened.runState)).toBe('flow');
  });

  it('SignalDelivery without runId scans the session for a matching parked run', async () => {
    const sessionId = 'legacy-scan-sess';
    const store = new MemoryStore();
    const agents = agentsMap();
    const flow = await openRun(agents, openOpts(store, sessionId, { kind: 'flow' }));
    flow.runState.status = 'paused';
    flow.runState.waitingFor = parkedWaitingFor('scan-req', 'approve');
    await flow.runStore.putRunState(flow.runState);

    const opened = await openRun(
      agents,
      openOpts(store, sessionId, {
        signalDelivery: signalFor(flow.runState, 'approve'),
      }),
    );

    expect(opened.runState.runId).toBe(flow.runState.runId);
  });
});

describe('Runtime.getRun', () => {
  it('returns the conversation run when addressed by sessionId', async () => {
    const sessionId = 'getrun-conv';
    const store = new MemoryStore();
    const runtime = createRuntime({
      agents: [defineAgent({ id: defaultAgentId, model: stubModel })],
      defaultAgentId,
      sessionStore: store,
      defaultModel: stubModel,
    });
    await runtime.run({ sessionId, input: 'hello' });

    const handle = await runtime.getRun(sessionId);
    expect(handle).not.toBeNull();
    expect(handle!.runId).toBe(sessionId);
    expect(handle!.kind).toBe('conversation');
    expect(handle!.sessionId).toBe(sessionId);
  });

  it('returns a flow run only when scoped to its session', async () => {
    const sessionId = 'getrun-flow';
    const store = new MemoryStore();
    const agents = agentsMap();
    const flow = await openRun(agents, openOpts(store, sessionId, { kind: 'flow' }));
    const runtime = createRuntime({
      agents: [defineAgent({ id: defaultAgentId, model: stubModel })],
      defaultAgentId,
      sessionStore: store,
      defaultModel: stubModel,
    });

    expect(await runtime.getRun(flow.runState.runId)).toBeNull();
    const handle = await runtime.getRun(flow.runState.runId, sessionId);
    expect(handle).not.toBeNull();
    expect(handle!.runId).toBe(flow.runState.runId);
    expect(handle!.kind).toBe('flow');
    expect(handle!.sessionId).toBe(sessionId);
  });

  it('returns null for an unknown runId', async () => {
    const store = new MemoryStore();
    const runtime = createRuntime({
      agents: [defineAgent({ id: defaultAgentId, model: stubModel })],
      defaultAgentId,
      sessionStore: store,
      defaultModel: stubModel,
    });
    await runtime.run({ sessionId: 'getrun-unknown', input: 'x' });
    expect(await runtime.getRun('no-such-run', 'getrun-unknown')).toBeNull();
  });

  it('returns null when a runId is queried under another session', async () => {
    const store = new MemoryStore();
    const flow = await openRun(agentsMap(), openOpts(store, 'owner-sess', { kind: 'flow' }));
    const runtime = createRuntime({
      agents: [defineAgent({ id: defaultAgentId, model: stubModel })],
      defaultAgentId,
      sessionStore: store,
      defaultModel: stubModel,
    });
    await runtime.run({ sessionId: 'other-sess', input: 'x' });
    expect(await runtime.getRun(flow.runState.runId, 'other-sess')).toBeNull();
  });
});

describe('session-serial conversation, runs-parallel', () => {
  it('two flow-run turns on the same session overlap', async () => {
    const sessionId = 'parallel-flow-sess';
    const store = new MemoryStore();
    const ping = defineTool({
      name: 'ping',
      description: 'ping',
      input: z.object({ who: z.string() }),
      execute: async ({ who }: { who: string }) => ({ who }),
    });
    const agents = agentsMap();
    const flowA = await openRun(agents, openOpts(store, sessionId, { kind: 'flow' }));
    const flowB = await openRun(agents, openOpts(store, sessionId, { kind: 'flow' }));

    let inFlight = 0;
    let maxInFlight = 0;
    let sawOverlap!: () => void;
    const overlap = new Promise<void>((resolve) => {
      sawOverlap = resolve;
    });

    const driverFor = (who: string): ChannelDriver => ({
      async runAgentTurn(_node, ctx) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (maxInFlight >= 2) sawOverlap();
        await ctx.tool('ping', { who });
        await new Promise((r) => setTimeout(r, 40));
        inFlight -= 1;
        return { text: who, toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: 'x' };
      },
    });
    const convDriver: ChannelDriver = {
      async runAgentTurn(_node, ctx) {
        ctx.session.workingMemory.A = 'from-conversation';
        return { text: 'conv', toolResults: [] };
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

    const flowTurns = Promise.all([
      runtime.run({ sessionId, runId: flowA.runState.runId, input: 'a', driver: driverFor('A') }),
      runtime.run({ sessionId, runId: flowB.runState.runId, input: 'b', driver: driverFor('B') }),
    ]);
    await overlap;
    await runtime.run({ sessionId, input: 'chat', driver: convDriver });
    await flowTurns;

    expect(maxInFlight).toBeGreaterThanOrEqual(2);

    const runStore = new SessionRunStore(store, sessionId);
    const stepsA = await runStore.getSteps(flowA.runState.runId);
    const stepsB = await runStore.getSteps(flowB.runState.runId);
    const pingA = stepsA.filter((step) => step.name === 'ping');
    const pingB = stepsB.filter((step) => step.name === 'ping');
    expect(pingA).toHaveLength(1);
    expect(pingB).toHaveLength(1);
    expect(pingA[0]!.key).not.toBe(pingB[0]!.key);
    expect(pingA[0]!.result).toEqual({ who: 'A' });
    expect(pingB[0]!.result).toEqual({ who: 'B' });

    const session = (await store.get(sessionId))!;
    expect(session.workingMemory.A).toBe('from-conversation');
  });
});

describe('findUnresumableRuns scans every run in the session', () => {
  it('finds a flow run that is not keyed by sessionId', async () => {
    const store = new MemoryStore();
    const sessionId = 'unresumable-flow-sess';
    const session = makeTestSession(sessionId);
    await store.save(session);
    const runStore = new SessionRunStore(store, sessionId);
    const flowRun = makeRunState(sessionId, 'flow-run-abc');
    flowRun.kind = 'flow';
    flowRun.activeFlow = 'checkout';
    delete flowRun.effectKeyVersion;
    await runStore.initRun(flowRun);
    await runStore.appendStep(flowRun.runId, {
      index: 0,
      key: 'k',
      kind: 'tool',
      name: 'charge',
      status: 'finished',
      startedAt: 0,
      finishedAt: 0,
      epoch: 0,
    });

    const found = await findUnresumableRuns(store, { sessionIds: [sessionId] });
    expect(found).toHaveLength(1);
    expect(found[0]!.runId).toBe('flow-run-abc');
    expect(found[0]!.reason).toBe('legacy-effect-keys');
    expect(found[0]!.runId).not.toBe(sessionId);
  });
});

describe('DURABLE_RUNS_KEY map holds N runs', () => {
  it('conversation and flow runs coexist under distinct keys', async () => {
    const sessionId = 'coexist-sess';
    const store = new MemoryStore();
    const agents = agentsMap();
    await openRun(agents, openOpts(store, sessionId, { input: 'hi' }));
    const flow = await openRun(agents, openOpts(store, sessionId, { kind: 'flow' }));
    const session = (await store.get(sessionId))!;
    const runs = readSessionDurableRuns(session);
    expect(Object.keys(runs).sort()).toEqual([sessionId, flow.runState.runId].sort());
  });
});

function nameIntakeFlow() {
  const nameCollect = collect({
    id: 'name',
    schema: z.object({ name: z.string().min(1) }),
    required: ['name'],
    maxTurns: 5,
    instructions: () => 'Ask for the user name.',
    onComplete: () => ({ end: 'done' }),
  });
  return defineFlow({
    name: 'name-intake',
    description: 'Collect a name',
    start: nameCollect,
    nodes: [nameCollect],
  });
}

describe('flow-run turn input reaches a parked collect', () => {
  it('addressed turn input is consumed by the flow and the buffer is cleared', async () => {
    const sessionId = 'flow-input-sess';
    const store = new MemoryStore();
    const flow = nameIntakeFlow();
    const agent = defineAgent({
      id: defaultAgentId,
      model: stubModel,
      flows: [flow],
    });
    const opened = await openRun(
      new Map([[agent.id, agent]]),
      openOpts(store, sessionId, { kind: 'flow' }),
    );
    opened.runState.activeFlow = flow.name;
    opened.runState.activeNode = 'name';
    opened.runState.flowFrame = { flow: flow.name, state: {} };
    await opened.runStore.putRunState(opened.runState);

    const consumed: UserInputContent[] = [];
    const driver: ChannelDriver = {
      async runAgentTurn(_node, ctx) {
        const last = ctx.runState.messages.filter((m) => m.role === 'user').at(-1);
        const text = typeof last?.content === 'string' ? last.content : '';
        if (text) {
          return {
            text: '',
            toolResults: [
              {
                name: 'submit_name_data',
                args: { name: text },
                result: { name: text },
              },
            ],
          };
        }
        return { text: 'What is your name?', toolResults: [] };
      },
      async awaitUser(ctx) {
        const input = consumeAllPendingUserInput(ctx.session, ctx.runState) ?? '';
        consumed.push(input);
        return { type: 'message', input };
      },
    };

    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId,
      sessionStore: store,
      defaultModel: stubModel,
    });

    await runtime.run({
      sessionId,
      runId: opened.runState.runId,
      input: 'Jordan',
      driver,
    });

    expect(consumed).toEqual(['Jordan']);
    const after = await new SessionRunStore(store, sessionId).getRunState(opened.runState.runId);
    expect(after?.pendingInput).toBeUndefined();
    const session = (await store.get(sessionId))!;
    expect(hasPendingUserInput(session, after ?? undefined)).toBe(false);
  });
});

describe('flow-run close does not clobber session workingMemory', () => {
  it('a conversation write of key A survives a concurrent flow-run close', async () => {
    const sessionId = 'wm-clobber-sess';
    const store = new MemoryStore();
    const flow = await openRun(agentsMap(), openOpts(store, sessionId, { kind: 'flow' }));

    let flowEntered!: () => void;
    const flowStarted = new Promise<void>((resolve) => {
      flowEntered = resolve;
    });
    let releaseFlow!: () => void;
    const flowHold = new Promise<void>((resolve) => {
      releaseFlow = resolve;
    });

    const flowDriver: ChannelDriver = {
      async runAgentTurn() {
        flowEntered();
        await flowHold;
        return { text: 'flow-done', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: '' };
      },
    };
    const convDriver: ChannelDriver = {
      async runAgentTurn(_node, ctx) {
        ctx.session.workingMemory.A = 'from-conversation';
        return { text: 'conv-done', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: '' };
      },
    };

    const runtime = createRuntime({
      agents: [defineAgent({ id: defaultAgentId, model: stubModel, instructions: 'ok' })],
      defaultAgentId,
      sessionStore: store,
      defaultModel: stubModel,
    });

    const flowTurn = runtime.run({
      sessionId,
      runId: flow.runState.runId,
      input: 'flow',
      driver: flowDriver,
    });
    await flowStarted;
    await runtime.run({ sessionId, input: 'chat', driver: convDriver });
    releaseFlow();
    await flowTurn;

    const session = (await store.get(sessionId))!;
    expect(session.workingMemory.A).toBe('from-conversation');
  });
});

describe('public flow-run creation', () => {
  it('runtime.run({ kind: "flow" }) mints a flow run and crash-replay resumes the same id', async () => {
    const sessionId = 'crash-replay-sess';
    const store = new MemoryStore();
    const flow = nameIntakeFlow();
    const agent = defineAgent({
      id: defaultAgentId,
      model: stubModel,
      flows: [flow],
    });
    const driver: ChannelDriver = {
      async runAgentTurn() {
        return { text: 'ask', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: '' };
      },
    };
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId,
      sessionStore: store,
      defaultModel: stubModel,
    });

    await runtime.run({ sessionId, kind: 'flow', flowName: 'name-intake', driver });
    const session = (await store.get(sessionId))!;
    const flowRuns = Object.values(readSessionDurableRuns(session)).filter(
      (persisted) => runKind(persisted.runState) === 'flow',
    );
    expect(flowRuns).toHaveLength(1);
    const persistedId = flowRuns[0]!.runState.runId;
    expect(persistedId).not.toBe(sessionId);
    expect(flowRuns[0]!.runState.activeFlow).toBe('name-intake');

    const resumed = createRuntime({
      agents: [agent],
      defaultAgentId,
      sessionStore: store,
      defaultModel: stubModel,
    });
    await resumed.run({ sessionId, runId: persistedId, driver });
    const after = (await store.get(sessionId))!;
    const afterFlows = Object.values(readSessionDurableRuns(after)).filter(
      (persisted) => runKind(persisted.runState) === 'flow',
    );
    expect(afterFlows).toHaveLength(1);
    expect(afterFlows[0]!.runState.runId).toBe(persistedId);
  });

  it('does not mint a flow run into another session', async () => {
    const store = new MemoryStore();
    const victim = await openRun(agentsMap(), openOpts(store, 'victim-sess', { kind: 'flow' }));
    const runtime = createRuntime({
      agents: [defineAgent({ id: defaultAgentId, model: stubModel })],
      defaultAgentId,
      sessionStore: store,
      defaultModel: stubModel,
    });
    await expect(
      runtime.run({
        sessionId: 'attacker-sess',
        runId: victim.runState.runId,
        kind: 'flow',
        input: 'x',
      }),
    ).rejects.toBeInstanceOf(RunNotFoundError);
    expect(await store.get('attacker-sess')).toBeNull();
  });
});

describe('unknown runId must not create a session', () => {
  it('probing an unknown runId under a nonexistent sessionId does not create a session', async () => {
    const store = new MemoryStore();
    await expect(
      openRun(agentsMap(), openOpts(store, 'no-such-sess', { runId: 'guessed-run' })),
    ).rejects.toBeInstanceOf(RunNotFoundError);
    expect(await store.get('no-such-sess')).toBeNull();
  });
});

describe('legacy kind-less plain-input resume', () => {
  it('resumes a kind-less session-keyed run on plain input without a signal', async () => {
    const sessionId = 'legacy-plain-sess';
    const store = new MemoryStore();
    const session = makeTestSession(sessionId);
    await store.save(session);
    const runStore = new SessionRunStore(store, sessionId);
    const legacy = makeRunState(sessionId, sessionId);
    delete legacy.kind;
    await runStore.initRun(legacy);

    const opened = await openRun(
      agentsMap(),
      openOpts(store, sessionId, { input: 'hello again' }),
    );
    expect(opened.runState.runId).toBe(sessionId);
    expect(runKind(opened.runState)).toBe('conversation');
    expect(opened.runState.kind).toBe('conversation');
    expect(opened.runState.messages.at(-1)).toEqual({ role: 'user', content: 'hello again' });
  });
});

describe('per-run abort', () => {
  it('aborting one overlapping run leaves the other to complete', async () => {
    const sessionId = 'abort-one-sess';
    const store = new MemoryStore();
    const agents = agentsMap();
    const flowA = await openRun(agents, openOpts(store, sessionId, { kind: 'flow' }));
    const flowB = await openRun(agents, openOpts(store, sessionId, { kind: 'flow' }));

    let started = 0;
    let bothStarted!: () => void;
    const ready = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    let releaseB!: () => void;
    const holdB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    const driverA: ChannelDriver = {
      async runAgentTurn(_node, ctx) {
        started += 1;
        if (started >= 2) bothStarted();
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(ctx.abortSignal?.reason ?? new Error('aborted'));
          if (ctx.abortSignal?.aborted) {
            onAbort();
            return;
          }
          ctx.abortSignal?.addEventListener('abort', onAbort, { once: true });
        });
        return { text: 'A', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: '' };
      },
    };
    const driverB: ChannelDriver = {
      async runAgentTurn(_node, ctx) {
        started += 1;
        if (started >= 2) bothStarted();
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 5_000);
          const onAbort = () => {
            clearTimeout(timer);
            reject(ctx.abortSignal?.reason ?? new Error('aborted'));
          };
          if (ctx.abortSignal?.aborted) {
            onAbort();
            return;
          }
          ctx.abortSignal?.addEventListener('abort', onAbort, { once: true });
          void holdB.then(() => {
            clearTimeout(timer);
            resolve();
          });
        });
        return { text: 'B-ok', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: '' };
      },
    };

    const runtime = createRuntime({
      agents: [defineAgent({ id: defaultAgentId, model: stubModel, instructions: 'ok' })],
      defaultAgentId,
      sessionStore: store,
      defaultModel: stubModel,
    });

    const abortA = new AbortController();
    const turnA = runtime.run({
      sessionId,
      runId: flowA.runState.runId,
      input: 'a',
      driver: driverA,
      abortSignal: abortA.signal,
    });
    const turnB = runtime.run({
      sessionId,
      runId: flowB.runState.runId,
      input: 'b',
      driver: driverB,
    });
    await ready;
    abortA.abort('stop-A');
    await expect(turnA).rejects.toBeTruthy();
    releaseB();
    const resultB = await turnB;
    expect(resultB.text).toBe('B-ok');
  });
});

describe('legacy signal resume lock', () => {
  it('legacy signal resume of a flow run does not take the session lock', async () => {
    const sessionId = 'legacy-lock-sess';
    const store = new MemoryStore();
    const agents = agentsMap();
    const flow = await openRun(agents, openOpts(store, sessionId, { kind: 'flow' }));
    flow.runState.status = 'paused';
    flow.runState.waitingFor = parkedWaitingFor('scan-req', 'approve');
    await flow.runStore.putRunState(flow.runState);

    let convHolding = false;
    let releaseConv!: () => void;
    const convHold = new Promise<void>((resolve) => {
      releaseConv = resolve;
    });
    let convEntered!: () => void;
    const convStarted = new Promise<void>((resolve) => {
      convEntered = resolve;
    });

    const convDriver: ChannelDriver = {
      async runAgentTurn() {
        convHolding = true;
        convEntered();
        await convHold;
        convHolding = false;
        return { text: 'conv', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: '' };
      },
    };
    let flowStartedWhileConvHeld = false;
    const flowDriver: ChannelDriver = {
      async runAgentTurn() {
        flowStartedWhileConvHeld = convHolding;
        return { text: 'flow', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: '' };
      },
    };

    const runtime = createRuntime({
      agents: [defineAgent({ id: defaultAgentId, model: stubModel, instructions: 'ok' })],
      defaultAgentId,
      sessionStore: store,
      defaultModel: stubModel,
    });

    const convTurn = runtime.run({ sessionId, input: 'chat', driver: convDriver });
    await convStarted;
    const flowTurn = runtime.run({
      sessionId,
      signalDelivery: signalFor(flow.runState, 'approve'),
      driver: flowDriver,
    });
    const winner = await Promise.race([
      flowTurn.then(() => 'flow' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1000)),
    ]);
    expect(winner).toBe('flow');
    expect(flowStartedWhileConvHeld).toBe(true);
    releaseConv();
    await convTurn;
  });
});
