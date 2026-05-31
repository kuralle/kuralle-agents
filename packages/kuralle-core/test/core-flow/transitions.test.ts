import { describe, expect, it } from 'bun:test';
import {
  action,
  collect,
  decide,
  defineFlow,
  reply,
  type FlowNode,
} from '../../src/types/flow.js';
import { normalizeTransition } from '../../src/flow/normalizeTransition.js';
import { z } from 'zod';

describe('normalizeTransition', () => {
  const nodeA = reply({ id: 'a', instructions: 'A' });
  const nodeB = reply({ id: 'b', instructions: 'B' });

  it('normalizes node refs and thunks to goto', () => {
    expect(normalizeTransition(nodeB)).toEqual({ kind: 'goto', node: nodeB });
    expect(normalizeTransition(() => nodeB)).toEqual({ kind: 'goto', node: nodeB });
    expect(normalizeTransition({ goto: nodeB })).toEqual({ kind: 'goto', node: nodeB });
    expect(normalizeTransition({ goto: () => nodeB, data: { x: 1 } })).toEqual({
      kind: 'goto',
      node: nodeB,
      data: { x: 1 },
    });
  });

  it('normalizes terminal transitions', () => {
    expect(normalizeTransition('stay')).toEqual({ kind: 'stay' });
    expect(normalizeTransition({ end: 'done' })).toEqual({ kind: 'end', reason: 'done' });
    expect(normalizeTransition({ handoff: 'support', reason: 'billing' })).toEqual({
      kind: 'handoff',
      to: 'support',
      reason: 'billing',
    });
    expect(normalizeTransition({ escalate: 'needs human' })).toEqual({
      kind: 'escalate',
      reason: 'needs human',
    });
  });
});

describe('runFlow returned transitions (mocked driver)', () => {
  it('routes reply.next, collect.onComplete, action.run, and decide.decide', async () => {
    const endNode = reply({ id: 'end', instructions: 'End', next: () => ({ end: 'done' }) });
    const gotoTarget = reply({ id: 'goto-target', instructions: 'Goto', next: () => ({ end: 'done' }) });

    const replyNext = reply({ id: 'reply-next', instructions: 'Reply', next: () => endNode });
    const collectNode = collect({
      id: 'collect',
      schema: z.object({ name: z.string() }),
      onComplete: () => gotoTarget,
    });
    const actionNode = action({ id: 'action', run: () => ({ handoff: 'billing' }) });
    const decideNode = decide({
      id: 'decide',
      instructions: 'Decide',
      schema: z.object({ route: z.enum(['a', 'b']) }),
      decide: () => ({ end: 'decided' }),
    });

    const collectDriver = {
      async runAgentTurn() {
        return {
          text: 'collected',
          toolResults: [{ name: 'submit_collect_data', args: { name: 'Ada' }, result: { name: 'Ada' } }],
        };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'next' };
      },
      async runStructured() {
        return { route: 'a' };
      },
    };

    const defaultDriver = {
      async runAgentTurn() {
        return { text: 'ok', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'next' };
      },
      async runStructured() {
        return { route: 'a' };
      },
    };

    const { runFlow } = await import('../../src/flow/runFlow.js');
    const { setupDurableHarness } = await import('../core-durable/helpers.js');
    const { createRunContext } = await import('../../src/runtime/ctx.js');
    const { CoreToolExecutor } = await import('../../src/tools/effect/index.js');

    async function runCase(
      startId: string,
      startNode: FlowNode,
      driver: typeof defaultDriver,
      assert: (result: Awaited<ReturnType<typeof runFlow>>, runState: import('../../src/runtime/durable/types.js').RunState) => void,
    ) {
      const flow = defineFlow({
        name: `flow-${startId}`,
        description: 'test',
        start: startNode,
        nodes: [replyNext, collectNode, actionNode, decideNode, endNode, gotoTarget],
      });

      const { session, runStore, runState } = await setupDurableHarness(`sess-${startId}`, `run-${startId}`);
      runState.activeNode = startId;

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
      assert(result, runState);
    }

    await runCase('reply-next', replyNext, defaultDriver, (result) => {
      expect(result).toEqual({ kind: 'ended', reason: 'done' });
    });

    await runCase('collect', collectNode, collectDriver as typeof defaultDriver, (result, state) => {
      expect(result).toEqual({ kind: 'ended', reason: 'done' });
      expect(state.activeNode).toBe('goto-target');
    });

    await runCase('action', actionNode, defaultDriver, (result) => {
      expect(result).toEqual({ kind: 'handoff', to: 'billing', reason: undefined });
    });

    await runCase('decide', decideNode, defaultDriver, (result) => {
      expect(result).toEqual({ kind: 'ended', reason: 'decided' });
    });
  });

  it('routes stay on reply nodes', async () => {
    const stayNode = reply({ id: 'stay', instructions: 'Stay', next: () => 'stay' });
    const flow = defineFlow({
      name: 'stay-flow',
      description: 'stay',
      start: stayNode,
      nodes: [stayNode],
    });

    let awaited = false;
    const driver = {
      async runAgentTurn() {
        return { text: 'waiting', toolResults: [] };
      },
      async awaitUser() {
        awaited = true;
        throw new Error('stop-after-await');
      },
    };

    const { setupDurableHarness } = await import('../core-durable/helpers.js');
    const { createRunContext } = await import('../../src/runtime/ctx.js');
    const { CoreToolExecutor } = await import('../../src/tools/effect/index.js');
    const { runFlow } = await import('../../src/flow/runFlow.js');

    const { session, runStore, runState } = await setupDurableHarness('stay-sess', 'stay-run');
    runState.activeNode = 'stay';
    const { setPendingUserInput } = await import('../../src/runtime/channels/inputBuffer.js');
    setPendingUserInput(session, 'follow-up');

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as import('ai').LanguageModel,
      emit: () => {},
    });

    await expect(runFlow(flow, runState, driver, ctx)).rejects.toThrow('stop-after-await');
    expect(awaited).toBe(true);
    expect(runState.activeNode).toBe('stay');
  });
});
