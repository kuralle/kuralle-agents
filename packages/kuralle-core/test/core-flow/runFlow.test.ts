import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { action, decide, defineFlow, reply } from '../../src/types/flow.js';
import { runFlow, FlowOscillationError } from '../../src/flow/runFlow.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setupDurableHarness, reloadRunState } from '../core-durable/helpers.js';
import { setPendingUserInput, consumePendingUserInput } from '../../src/runtime/channels/inputBuffer.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';

describe('runFlow action exactly-once via effect log', () => {
  it('does not re-fire ctx.tool when re-entering the action node on resume', async () => {
    const chargeSpy = { count: 0 };
    const toolExecutor = {
      execute: async ({ name }: { name: string; args: unknown; session: unknown }) => {
        if (name !== 'charge') {
          throw new Error(`Unexpected tool: ${name}`);
        }
        chargeSpy.count += 1;
        return { charged: true };
      },
    };

    const afterAction = reply({ id: 'after', instructions: 'After action', next: () => ({ end: 'done' }) });
    const chargeAction = action({
      id: 'charge',
      run: async (_state, ctx) => {
        await ctx.tool('charge', { amount: 10 });
        return afterAction;
      },
    });

    const flow = defineFlow({
      name: 'charge-flow',
      description: 'Charge once',
      start: chargeAction,
      nodes: [chargeAction, afterAction],
    });

    const driver = {
      async runAgentTurn() {
        return { text: 'done', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'ok' };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness('action-sess', 'action-run');
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor,
      model: {} as import('ai').LanguageModel,
      emit: () => {},
    });

    const first = await runFlow(flow, runState, driver, ctx);
    expect(first).toEqual({ kind: 'ended', reason: 'done' });
    expect(chargeSpy.count).toBe(1);

    const reloaded = await reloadRunState(runStore, runState.runId);
    reloaded.activeNode = 'charge';
    reloaded.status = 'running';

    const ctx2 = await createRunContext({
      session,
      runState: reloaded,
      runStore,
      steps: await runStore.getSteps(runState.runId),
      toolExecutor,
      model: {} as import('ai').LanguageModel,
      emit: () => {},
    });

    await runFlow(flow, reloaded, driver, ctx2);
    expect(chargeSpy.count).toBe(1);
  });
});

describe('runFlow oscillation cap', () => {
  it('blocks ping-pong transitions after maxOscillations', async () => {
    let nodeA!: ReturnType<typeof action>;
    let nodeB!: ReturnType<typeof action>;
    nodeB = action({ id: 'b', run: () => nodeA });
    nodeA = action({ id: 'a', run: () => nodeB });

    const flow = defineFlow({
      name: 'ping-pong',
      description: 'Oscillates',
      start: nodeA,
      nodes: [nodeA, nodeB],
      maxOscillations: 2,
    });

    const driver = {
      async runAgentTurn() {
        return { text: '', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'x' };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness('osc-sess', 'osc-run');
    const errors: HarnessStreamPart[] = [];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as import('ai').LanguageModel,
      emit: (part) => errors.push(part),
    });

    await expect(runFlow(flow, runState, driver, ctx)).rejects.toBeInstanceOf(FlowOscillationError);
    expect(errors.some((part) => part.type === 'error')).toBe(true);
  });
});

describe('runFlow transition events', () => {
  it('emits node-enter and flow-transition on goto', async () => {
    const target = reply({ id: 'target', instructions: 'Target', next: () => ({ end: 'ok' }) });
    const source = action({ id: 'source', run: () => target });

    const flow = defineFlow({
      name: 'events-flow',
      description: 'Events',
      start: source,
      nodes: [source, target],
    });

    const parts: HarnessStreamPart[] = [];
    const driver = {
      async runAgentTurn() {
        return { text: 'hi', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'next' };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness('evt-sess', 'evt-run');
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as import('ai').LanguageModel,
      emit: (part) => parts.push(part),
    });

    await runFlow(flow, runState, driver, ctx);

    expect(parts.some((part) => part.type === 'flow-enter')).toBe(true);
    expect(parts.some((part) => part.type === 'node-enter' && part.nodeName === 'source')).toBe(true);
    expect(parts.some((part) => part.type === 'flow-transition' && part.from === 'source' && part.to === 'target')).toBe(
      true,
    );
    expect(parts.some((part) => part.type === 'node-exit' && part.nodeName === 'source')).toBe(true);
  });
});

describe('runFlow decide resume consumes pending user input', () => {
  it('feeds the resumed turn input to the decision on the first attempt (not stale context)', async () => {
    let firstCallSawInput: boolean | undefined;
    const pick = decide({
      id: 'pick',
      instructions: 'Pick checkout or more',
      schema: z.object({ choice: z.string() }),
      decide: (sel) => ((sel as { choice: string }).choice === 'checkout' ? { end: 'done' } : 'stay'),
    });
    const flow = defineFlow({ name: 'pick-flow', description: 'pick', start: pick, nodes: [pick] });

    const driver = {
      async runAgentTurn() {
        return { text: '', toolResults: [] };
      },
      async awaitUser(ctx: import('../../src/types/run-context.js').RunContext) {
        return { type: 'message' as const, input: consumePendingUserInput(ctx.session) };
      },
      async runStructured(_node: unknown, ctx: import('../../src/types/run-context.js').RunContext) {
        const sawInput = ctx.runState.messages.some((m) => String(m.content).includes('checkout'));
        if (firstCallSawInput === undefined) firstCallSawInput = sawInput;
        return { choice: sawInput ? 'checkout' : 'none' };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness('decide-resume-sess', 'decide-resume-run');
    // Simulate a paused flow parked at the decide node, with the user's next-turn
    // reply buffered (exactly what openRun does on an HTTP resume).
    runState.activeFlow = 'pick-flow';
    runState.activeNode = 'pick';
    setPendingUserInput(session, 'checkout');

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as import('ai').LanguageModel,
      emit: () => {},
    });

    const result = await runFlow(flow, runState, driver, ctx);

    // Before the fix the decide ran runStructured over stale messages (no input),
    // so the very first decision could never see the user's reply.
    expect(firstCallSawInput).toBe(true);
    expect(result).toEqual({ kind: 'ended', reason: 'done' });
  });
});
