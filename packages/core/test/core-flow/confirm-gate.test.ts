import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { action, collect, confirmGate, defineFlow } from '../../src/types/flow.js';
import { parseConfirmation } from '../../src/flow/confirmParse.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { hostLoop } from '../../src/runtime/hostLoop.js';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setupDurableHarness } from '../core-durable/helpers.js';
import { setPendingUserInput, consumePendingUserInput } from '../../src/runtime/channels/inputBuffer.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';
import type { ChannelDriver } from '../../src/types/channel.js';
import type { RunContext } from '../../src/types/run-context.js';

function makeGateFlow(mutationSpy: { count: number }) {
  let gate!: ReturnType<typeof confirmGate>;
  let mutation!: ReturnType<typeof action>;

  const budgetCollect = collect({
    id: 'budget',
    schema: z.object({ amount: z.string() }),
    required: ['amount'],
    instructions: () => 'What is your budget?',
    onComplete: () => gate,
  });

  mutation = action({
    id: 'mutate',
    run: async () => {
      mutationSpy.count += 1;
      return { end: 'done' };
    },
  });

  gate = confirmGate({
    id: 'confirm',
    instructions: 'Confirm your order details?',
    onConfirm: mutation,
    onDecline: budgetCollect,
  });

  return defineFlow({
    name: 'confirm-gate-flow',
    description: 'collect then confirm gate then mutate',
    start: budgetCollect,
    nodes: [budgetCollect, gate, mutation],
  });
}

function gateDriver(overrides?: Partial<ChannelDriver>): ChannelDriver {
  return {
    async runAgentTurn() {
      return { text: '', toolResults: [] };
    },
    async awaitUser(ctx: RunContext) {
      return { type: 'message' as const, input: consumePendingUserInput(ctx.session) };
    },
    async runStructured() {
      throw new Error('runStructured must not be called for confirm gates');
    },
    ...overrides,
  };
}

async function runAtGate(input: string, mutationSpy: { count: number }) {
  const flow = makeGateFlow(mutationSpy);
  const { session, runStore, runState } = await setupDurableHarness('gate-sess', 'gate-run');
  runState.activeFlow = flow.name;
  runState.activeNode = 'confirm';
  runState.state['__collect_budget'] = { amount: '50000' };
  runState.messages = [{ role: 'user', content: input }];

  const ctx = await createRunContext({
    session,
    runState,
    runStore,
    steps: [],
    toolExecutor: new CoreToolExecutor({ tools: {} }),
    model: {} as import('ai').LanguageModel,
    emit: () => {},
  });

  return runFlow(flow, runState, gateDriver(), ctx);
}

describe('W9 confirm gate', () => {
  it('affirm advances to mutation and ends', async () => {
    const spy = { count: 0 };
    const result = await runAtGate('yes please', spy);
    expect(result).toEqual({ kind: 'ended', reason: 'done' });
    expect(spy.count).toBe(1);
  });

  it('off-script question does not advance or mutate', async () => {
    const spy = { count: 0 };
    const result = await runAtGate('what desserts do you have?', spy);
    expect(result).toEqual({ kind: 'awaitingUser' });
    expect(spy.count).toBe(0);
  });

  it('explicit decline routes to onDecline without mutation', async () => {
    const spy = { count: 0 };
    const result = await runAtGate('no thanks', spy);
    expect(result).toEqual({ kind: 'awaitingUser' });
    expect(spy.count).toBe(0);
  });

  it('decline wins over mixed affirm + change language', async () => {
    const spy = { count: 0 };
    const result = await runAtGate('yes but change the time', spy);
    expect(result).toEqual({ kind: 'awaitingUser' });
    expect(spy.count).toBe(0);
  });

  it('bare value at gate is ambiguous (no mutation)', async () => {
    const spy = { count: 0 };
    const result = await runAtGate('50000', spy);
    expect(result).toEqual({ kind: 'awaitingUser' });
    expect(spy.count).toBe(0);
  });

  it('never calls runStructured even when driver.runStructured throws', async () => {
    const spy = { count: 0 };
    const result = await runAtGate('yes', spy);
    expect(result).toEqual({ kind: 'ended', reason: 'done' });
    expect(spy.count).toBe(1);
  });

  it('multilingual affirm and decline via parseConfirmation', () => {
    expect(parseConfirmation('ඔව්')).toBe('affirm');
    expect(parseConfirmation('சரி')).toBe('affirm');
    expect(parseConfirmation('ow')).toBe('affirm');
    expect(parseConfirmation('sari')).toBe('affirm');
    expect(parseConfirmation('නැහැ')).toBe('decline');
    expect(parseConfirmation('illai')).toBe('decline');
    expect(parseConfirmation('epa')).toBe('decline');
  });

  it('post-END message does not re-fire mutation (hostLoop clears active flow)', async () => {
    const spy = { count: 0 };
    const flow = makeGateFlow(spy);
    const agent = defineAgent({ id: 'sales', flows: [flow], model: {} as import('ai').LanguageModel });

    const { session, runStore, runState } = await setupDurableHarness('post-end-sess', 'post-end-run');
    runState.state['__collect_budget'] = { amount: '50000' };
    runState.activeFlow = flow.name;
    runState.activeNode = 'confirm';
    runState.messages = [{ role: 'user', content: 'yes please' }];

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as import('ai').LanguageModel,
      emit: () => {},
    });

    const first = await hostLoop({ agent, run: runState, driver: gateDriver(), ctx });
    expect(first).toEqual({ kind: 'turnComplete' });
    expect(spy.count).toBe(1);
    expect(runState.activeNode).toBeUndefined();
    expect(runState.activeFlow).toBeUndefined();
    expect(runState.state.__completedFlows).toEqual(['confirm-gate-flow']);

    runState.messages = [...runState.messages, { role: 'user', content: 'yes please' }];

    const ctx2 = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as import('ai').LanguageModel,
      emit: () => {},
    });

    const second = await hostLoop({
      agent,
      run: runState,
      driver: gateDriver(),
      ctx: ctx2,
      select: async () => ({ kind: 'keep' }),
    });

    expect(second).toEqual({ kind: 'turnComplete' });
    expect(spy.count).toBe(1);
    expect(runState.activeFlow).toBeUndefined();
    expect(runState.activeNode).toBeUndefined();
  });

  it('parks when turn input was consumed before gate receives a reply', async () => {
    const spy = { count: 0 };
    const flow = makeGateFlow(spy);
    const start = action({ id: 'start', run: async () => flow.nodes.find((n) => n.id === 'confirm')! });
    const parkedFlow = defineFlow({
      name: 'park-flow',
      description: 'park at gate',
      start,
      nodes: [start, ...flow.nodes],
    });

    const { session, runStore, runState } = await setupDurableHarness('park-sess', 'park-run');
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as import('ai').LanguageModel,
      emit: () => {},
    });
    ctx.turnInputConsumed = true;

    const result = await runFlow(parkedFlow, runState, gateDriver(), ctx);
    expect(result).toEqual({ kind: 'awaitingUser' });
    expect(spy.count).toBe(0);
  });

  it('resume with pending input affirms without runStructured', async () => {
    const spy = { count: 0 };
    const flow = makeGateFlow(spy);
    const { session, runStore, runState } = await setupDurableHarness('resume-sess', 'resume-run');
    runState.activeFlow = flow.name;
    runState.activeNode = 'confirm';
    runState.state['__collect_budget'] = { amount: '50000' };
    setPendingUserInput(session, 'yes please');

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as import('ai').LanguageModel,
      emit: () => {},
    });

    const result = await runFlow(flow, runState, gateDriver(), ctx);
    expect(result).toEqual({ kind: 'ended', reason: 'done' });
    expect(spy.count).toBe(1);
  });
});

describe('parseConfirmation unit table', () => {
  const cases: Array<{ input: string; expected: ReturnType<typeof parseConfirmation> }> = [
    { input: 'another', expected: 'ambiguous' },
    { input: 'book', expected: 'ambiguous' },
    { input: 'ok so what about desserts?', expected: 'ambiguous' },
    { input: 'go ahead', expected: 'affirm' },
    { input: 'no', expected: 'decline' },
    { input: 'proceed', expected: 'affirm' },
    { input: 'y', expected: 'affirm' },
    { input: 'yummy', expected: 'ambiguous' },
    { input: 'now', expected: 'ambiguous' },
    { input: 'know', expected: 'ambiguous' },
    { input: "what's the delivery place?", expected: 'ambiguous' },
    { input: 'yes but change the time', expected: 'decline' },
    { input: '50000', expected: 'ambiguous' },
  ];

  for (const { input, expected } of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => {
      expect(parseConfirmation(input)).toBe(expected);
    });
  }
});

describe('confirm gate events', () => {
  it('ambiguous stay keeps gate node active', async () => {
    const spy = { count: 0 };
    const flow = makeGateFlow(spy);
    const { session, runStore, runState } = await setupDurableHarness('ambig-sess', 'ambig-run');
    runState.activeFlow = flow.name;
    runState.activeNode = 'confirm';
    runState.state['__collect_budget'] = { amount: '1' };
    runState.messages = [{ role: 'user', content: 'what desserts do you have?' }];

    const parts: HarnessStreamPart[] = [];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as import('ai').LanguageModel,
      emit: (part) => parts.push(part),
    });

    const result = await runFlow(flow, runState, gateDriver(), ctx);
    expect(result).toEqual({ kind: 'awaitingUser' });
    expect(runState.activeNode).toBe('confirm');
    expect(spy.count).toBe(0);
  });
});
