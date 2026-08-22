import { describe, expect, it } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import { action, collect, defineFlow, reply, type Transition } from '../../src/types/flow.js';
import type { ChannelDriver } from '../../src/types/channel.js';
import type { StreamPart, TurnHandle } from '../../src/types/stream.js';
import type { HostSelection } from '../../src/runtime/select.js';
import { makeRunState, makeTestSession, stubModel } from '../core-durable/helpers.js';
import {
  mockV3GenerateObjectModel,
  mockV3GenerateResult,
} from '../helpers/mockLanguageModelV3Results.js';

async function collectParts(handle: TurnHandle): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  for await (const part of handle.events) parts.push(part);
  await handle;
  return parts;
}

async function seedActiveFlow(
  store: MemoryStore,
  sessionId: string,
  agentId: string,
  flowName: string,
): Promise<void> {
  const session = makeTestSession(sessionId);
  session.currentAgent = agentId;
  await store.save(session);
  const runStore = new SessionRunStore(store, sessionId);
  const runState = makeRunState(sessionId, sessionId);
  runState.activeAgentId = agentId;
  runState.activeFlow = flowName;
  await runStore.initRun(runState);
}

const quietDriver: ChannelDriver = {
  async runAgentTurn() {
    return { text: 'done', toolResults: [] };
  },
  async awaitUser(ctx) {
    const { consumeAllPendingUserInput } = await import(
      '../../src/runtime/channels/inputBuffer.js'
    );
    return {
      type: 'message',
      input: consumeAllPendingUserInput(ctx.session) ?? '',
    };
  },
};

describe('R-01 approval identity freezes the displayed operation', () => {
  it('executes the original request once even when action inputs change before resume', async () => {
    const executed: unknown[] = [];
    const dispatch = defineTool({
      name: 'dispatch',
      description: 'Dispatch a vendor',
      input: z.object({
        workOrderId: z.string(),
        vendorId: z.string(),
        estimateUsd: z.number(),
      }),
      needsApproval: true,
      execute: async (args) => {
        executed.push(args);
        return { dispatched: true };
      },
    });
    let requestedArgs = {
      workOrderId: 'WO-HEAT',
      vendorId: 'v-hvac-1',
      estimateUsd: 320,
    };
    const source = action({
      id: 'dispatch-action',
      run: async (_state, ctx) => {
        if (executed.length === 0) {
          await ctx.tool('dispatch', requestedArgs);
        }
        return { end: 'done' };
      },
    });
    const flow = defineFlow({
      name: 'frozen-dispatch',
      description: 'Approval identity',
      binding: true,
      start: source,
      nodes: [source],
    });
    const agent = defineAgent({ id: 'dispatcher', model: stubModel, flows: [flow] });
    const store = new MemoryStore();
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      defaultModel: stubModel,
      sessionStore: store,
      tools: { dispatch },
      hostSelect: async (): Promise<HostSelection> => ({ kind: 'enterFlow', flow }),
    });
    const sessionId = 'frozen-approval';

    const pausedParts = await collectParts(
      runtime.run({ sessionId, input: 'dispatch', driver: quietDriver }),
    );
    const paused = pausedParts.find((part) => part.type === 'paused');
    expect(paused?.payload.interrupt.operation).toMatchObject({
      toolName: 'dispatch',
      args: requestedArgs,
    });
    expect(executed).toEqual([]);

    requestedArgs = {
      workOrderId: 'WO-WINDOW',
      vendorId: 'v-gen-1',
      estimateUsd: 75,
    };
    await collectParts(
      runtime.run({
        sessionId,
        signalDelivery: {
          signalId: 'approve-frozen-dispatch',
          requestId: paused!.payload.interrupt.requestId,
          name: '__approval',
          actor: { id: 'owner-1', type: 'user' },
          decision: 'approve',
        },
        driver: quietDriver,
      }),
    );

    expect(executed).toEqual([
      {
        workOrderId: 'WO-HEAT',
        vendorId: 'v-hvac-1',
        estimateUsd: 320,
      },
    ]);
    const runStore = new SessionRunStore(store, sessionId);
    const steps = await runStore.getSteps(sessionId);
    expect(steps.filter((step) => step.kind === 'tool' && step.name === 'dispatch')).toHaveLength(1);
  });
});

function expectedTransitionPart(kind: 'end' | 'handoff' | 'escalate' | 'goto', parts: StreamPart[]) {
  if (kind === 'end') {
    return parts.some((part) => part.type === 'flow-end' && part.payload.reason === 'verified');
  }
  if (kind === 'handoff') {
    return parts.some((part) => part.type === 'handoff' && part.payload.targetAgent === 'human');
  }
  if (kind === 'escalate') {
    return parts.some(
      (part) => part.type === 'paused' && part.payload.waitingFor === '__escalate',
    );
  }
  return parts.some(
    (part) => part.type === 'flow-transition' && part.payload.to === 'target',
  );
}

describe('R-03 verification precedes every transition reduction', () => {
  for (const kind of ['end', 'handoff', 'escalate', 'goto'] as const) {
    it(`blocks and permits ${kind} through the public runtime`, async () => {
      const target = reply({
        id: 'target',
        instructions: 'Finish.',
        next: () => ({ end: 'verified' }),
      });
      const transition = (): Transition => {
        if (kind === 'end') return { end: 'verified' };
        if (kind === 'handoff') return { handoff: 'human', reason: 'verified' };
        if (kind === 'escalate') return { escalate: 'verified' };
        return target;
      };

      for (const approved of [false, true]) {
        const source = action({
          id: 'source',
          outputSchema: z.object({ approved: z.literal(true) }),
          run: async (state) => {
            if (approved) state.approved = true;
            return transition();
          },
        });
        const flow = defineFlow({
          name: `verify-${kind}-${approved}`,
          description: 'Verification order',
          binding: true,
          start: source,
          nodes: [source, target],
        });
        const agent = defineAgent({ id: 'verify-agent', model: stubModel, flows: [flow] });
        const runtime = createRuntime({
          agents: [agent],
          defaultAgentId: agent.id,
          defaultModel: stubModel,
          hostSelect: async (): Promise<HostSelection> => ({ kind: 'enterFlow', flow }),
        });
        const parts = await collectParts(
          runtime.run({
            sessionId: `verify-${kind}-${approved}`,
            input: 'go',
            driver: quietDriver,
          }),
        );

        expect(expectedTransitionPart(kind, parts)).toBe(approved);
        expect(parts.some((part) => part.type === 'error')).toBe(!approved);
      }
    });
  }

  it('blocks and permits a nested switchFlow reduction through the public runtime', async () => {
    for (const approved of [false, true]) {
      let routeCalls = 0;
      const routeModel = mockV3GenerateObjectModel(async () => {
        routeCalls += 1;
        return {
          object:
            routeCalls === 1
              ? {
                  action: 'enterFlow',
                  flowName: 'child',
                  agentId: null,
                  reason: 'nested request',
                  confidence: 1,
                }
              : {
                  action: 'keep',
                  flowName: null,
                  agentId: null,
                  reason: 'nested request handled',
                  confidence: 1,
                },
        };
      });
      routeCalls = 0;
      const childEnd = action({
        id: 'child-end',
        run: async (_state, ctx) => {
          await ctx.signal('child-hold', { schema: z.object({}) });
          return 'stay';
        },
      });
      const child = defineFlow({
        name: 'child',
        description: 'Nested child',
        start: childEnd,
        nodes: [childEnd],
      });
      const source = reply({
        id: 'source',
        instructions: 'Parent.',
        outputSchema: z.object({ approved: z.literal(true) }),
        next: () => 'stay',
      });
      const parent = defineFlow({
        name: 'parent',
        description: 'Parent',
        binding: true,
        start: source,
        nodes: [source],
        state: { input: () => approved ? { approved: true } : {} },
      });
      const agent = defineAgent({
        id: 'switch-agent',
        model: routeModel,
        flows: [parent, child],
        experimental: { outOfBandControl: true },
      });
      const store = new MemoryStore();
      const sessionId = `verify-switch-${approved}`;
      await seedActiveFlow(store, sessionId, agent.id, parent.name);
      const runtime = createRuntime({
        agents: [agent],
        defaultAgentId: agent.id,
        defaultModel: routeModel,
        sessionStore: store,
      });
      const parts = await collectParts(
        runtime.run({ sessionId, input: 'handle the nested request', driver: quietDriver }),
      );

      expect(
        parts.some((part) => part.type === 'flow-enter' && part.payload.flow === child.name),
      ).toBe(approved);
      expect(parts.some((part) => part.type === 'error')).toBe(!approved);
    }
  });
});

describe('R-04 nested flows own isolated persisted state frames', () => {
  it('keeps parent issue/urgency private, persists both frames, and restores only explicit output', async () => {
    let routeCalls = 0;
    const routeModel = new MockLanguageModelV3({
      doGenerate: async () => {
        routeCalls += 1;
        const object =
          routeCalls === 1
            ? {
                action: 'enterFlow',
                flowName: 'dispatch',
                agentId: null,
                reason: 'dispatch the heating order',
                confidence: 1,
              }
            : {
                action: 'keep',
                flowName: null,
                agentId: null,
                reason: 'nested request handled',
                confidence: 1,
              };
        return mockV3GenerateResult(JSON.stringify(object), 13);
      },
    });

    const observedChildStates: Array<Record<string, unknown>> = [];
    const dispatchAction = action({
      id: 'dispatch-action',
      run: async (state) => {
        observedChildStates.push({ ...state });
        const workOrderIssue =
          state.workOrderId === 'WO-HEAT' ? 'Radiator cold in bedroom' : '';
        return {
          end: 'child-complete',
          ...(workOrderIssue ? {} : {}),
        };
      },
    });
    const dispatchIntake = collect({
      id: 'dispatch_intake',
      schema: z.object({ workOrderId: z.string() }),
      required: ['workOrderId'],
      ask: () => 'Which work order?',
      onComplete: (data) => ({ goto: dispatchAction.id, data: data as Record<string, unknown> }),
    });
    const dispatch = defineFlow({
      name: 'dispatch',
      description: 'Dispatch a selected work order',
      start: dispatchIntake,
      nodes: [dispatchIntake, dispatchAction],
      state: {
        output: (state) => ({
          selectedWorkOrderId: state.workOrderId,
          vendorTrade: state.workOrderId === 'WO-HEAT' ? 'hvac' : 'general',
        }),
      },
    });
    const parentReply = reply({
      id: 'parent-reply',
      instructions: 'Finish the parent.',
      next: (_turn, state) => state.vendorTrade ? { end: 'parent-complete' } : 'stay',
    });
    const parent = defineFlow({
      name: 'intake',
      description: 'Parent intake',
      binding: true,
      start: parentReply,
      nodes: [parentReply],
      state: {
        input: () => ({ issue: 'Bedroom window latch broken', urgency: 'routine' }),
        output: (state) => state,
      },
    });
    const agent = defineAgent({
      id: 'frame-agent',
      model: routeModel,
      flows: [parent, dispatch],
      experimental: { outOfBandControl: true },
    });
    const store = new MemoryStore();
    const sessionId = 'flow-frame-persistence';
    await seedActiveFlow(store, sessionId, agent.id, parent.name);
    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: agent.id,
      defaultModel: routeModel,
      sessionStore: store,
    });
    const driver: ChannelDriver = {
      async runAgentTurn() {
        return { text: 'complete', toolResults: [] };
      },
      async runExtraction() {
        return {
          text: '',
          toolResults: [
            {
              name: 'submit_dispatch_intake_data',
              args: { workOrderId: 'WO-HEAT' },
              result: { workOrderId: 'WO-HEAT' },
            },
          ],
        };
      },
      async awaitUser(ctx) {
        const { consumeAllPendingUserInput } = await import(
          '../../src/runtime/channels/inputBuffer.js'
        );
        return {
          type: 'message',
          input: consumeAllPendingUserInput(ctx.session) ?? '',
        };
      },
    };
    const firstTrace = await runtime.runOnce({
      sessionId,
      input: 'dispatch heating work',
      driver,
    });
    const controlCalls = firstTrace.spans.filter((span) => span.kind === 'llm');
    expect(controlCalls).toHaveLength(1);
    expect(controlCalls[0]?.attributes.inputTokens).toBe(13);
    expect(firstTrace.spans.find((span) => span.kind === 'turn')?.attributes.tokensIn).toBe(13);
    const runStore = new SessionRunStore(store, sessionId);
    const parked = await runStore.getRunState(sessionId);
    expect(parked?.activeFlow).toBe('dispatch');
    expect(parked?.flowFrame?.state.issue).toBeUndefined();
    expect(parked?.flowFrame?.state.urgency).toBeUndefined();
    expect(parked?.flowStack?.[0]).toEqual({
      flow: 'intake',
      node: 'parent-reply',
      state: { issue: 'Bedroom window latch broken', urgency: 'routine' },
      flowDigest: 'code:intake',
    });

    await collectParts(runtime.run({ sessionId, input: 'WO-HEAT', driver }));
    const completed = await runStore.getRunState(sessionId);
    expect(observedChildStates).toHaveLength(1);
    expect(observedChildStates[0]).not.toHaveProperty('issue');
    expect(observedChildStates[0]).not.toHaveProperty('urgency');
    expect(completed?.state).toMatchObject({
      issue: 'Bedroom window latch broken',
      urgency: 'routine',
      selectedWorkOrderId: 'WO-HEAT',
      vendorTrade: 'hvac',
    });
    expect(completed?.flowFrame).toBeUndefined();
    expect(completed?.flowStack).toBeUndefined();
  });
});

describe('R-07 control-model calls preserve abort signals', () => {
  it('aborts an instrumented dispatcher call and closes its model span as an error', async () => {
    let receivedSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const routingModel = new MockLanguageModelV3({
      doGenerate: async (options) => {
        receivedSignal = options.abortSignal;
        markStarted();
        return new Promise((_resolve, reject) => {
          const fail = () => reject(new DOMException('cancelled', 'AbortError'));
          if (options.abortSignal?.aborted) fail();
          else options.abortSignal?.addEventListener('abort', fail, { once: true });
        });
      },
    });

    const router = defineAgent({ id: 'router', model: routingModel, handoffs: ['worker'] });
    const worker = defineAgent({ id: 'worker', model: stubModel });
    const runtime = createRuntime({
      agents: [router, worker],
      defaultAgentId: router.id,
      defaultModel: routingModel,
    });
    const controller = new AbortController();
    const handle = runtime.run({
      sessionId: 'routing-abort',
      input: 'route this',
      driver: quietDriver,
      abortSignal: controller.signal,
    });
    const partsPromise = (async () => {
      const parts: StreamPart[] = [];
      for await (const part of handle.events) parts.push(part);
      return parts;
    })();
    await started;
    controller.abort();

    await expect(handle).rejects.toMatchObject({ name: 'AbortError' });
    const parts = await partsPromise;
    expect(receivedSignal?.aborted).toBe(true);
    expect(parts.filter((part) => part.type === 'model-call-start')).toHaveLength(1);
    expect(
      parts.filter(
        (part) => part.type === 'model-call-end' && part.payload.finishReason === 'error',
      ),
    ).toHaveLength(1);
  });
});
