// Regression tests for routing-guard debt fixes (RD-01, RD-04).
//
// RD-01: lazy guard — classifier runs ONLY on empty no-control turns.
// RD-04: filler mitigation is prompt-level; runtime still treats any text as answered
//   (RD-08 semantic adequacy deferred).
import { describe, expect, it } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { reply, defineFlow } from '../../src/types/flow.js';
import { hostLoop } from '../../src/runtime/hostLoop.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import type { HostGuardVerdict } from '../../src/runtime/select.js';
import type { ChannelDriver, TurnControl } from '../../src/types/channel.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';
import { buildAgentReplyNode } from '../../src/runtime/agentReply.js';
import { buildHostControlTools } from '../../src/runtime/hostControlTools.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';

function flowAgent() {
  const end = reply({ id: 'book-start', instructions: 'x', next: () => ({ end: 'ok' }) });
  const flow = defineFlow({ name: 'book', description: 'Book an appointment', start: end, nodes: [end] });
  return defineAgent({ id: 'host', instructions: 'Answer the user', flows: [flow], model: stubModel });
}

function fakeDriver(turn: { text: string; control?: TurnControl }): ChannelDriver {
  return {
    outputCapability: 'kuralle-controlled-text',
    async runAgentTurn() {
      return { text: turn.text, toolResults: [], ...(turn.control ? { control: turn.control } : {}) };
    },
    async awaitUser() {
      return { type: 'message', input: 'x' };
    },
  } as ChannelDriver;
}

async function makeCtx(slug: string, emit: (p: HarnessStreamPart) => void = () => {}) {
  const { session, runStore, runState } = await setupDurableHarness(slug, slug);
  runState.messages = [{ role: 'user', content: 'I want to book an appointment' }];
  const ctx = await createRunContext({
    session,
    runState,
    runStore,
    steps: [],
    toolExecutor: new CoreToolExecutor({ tools: {} }),
    model: stubModel,
    emit,
  });
  return { ctx, runState };
}

function hostGuardEvents(parts: HarnessStreamPart[]) {
  return parts.filter(
    (p): p is Extract<HarnessStreamPart, { type: 'custom' }> =>
      p.type === 'custom' && p.name === 'host-guard',
  );
}

describe('routing guard debt fixes', () => {
  it('RD-01: answered turn makes ZERO classifier calls (lazy guard)', async () => {
    const agent = flowAgent();
    let classifyCalls = 0;
    const classify = async (): Promise<HostGuardVerdict> => {
      classifyCalls += 1;
      return { action: 'keep' };
    };
    const parts: HarnessStreamPart[] = [];
    const { ctx, runState } = await makeCtx('rd01', (p) => parts.push(p));

    const result = await hostLoop({
      agent,
      run: runState,
      driver: fakeDriver({ text: 'The first available slot is Friday at 7pm.' }),
      ctx,
      classify,
    });

    expect(result.kind).toBe('turnComplete');
    expect(classifyCalls).toBe(0);
    const assistant = runState.messages.filter((m) => m.role === 'assistant');
    expect(assistant.at(-1)?.content).toContain('Friday');
    const guardEvt = hostGuardEvents(parts)[0];
    expect(guardEvt?.data).toMatchObject({ invoked: false, reason: 'answered' });
  });

  it('RD-01: main-control turn makes ZERO classifier calls', async () => {
    const agent = flowAgent();
    let classifyCalls = 0;
    const classify = async (): Promise<HostGuardVerdict> => {
      classifyCalls += 1;
      return { action: 'enterFlow', flowName: 'book' };
    };
    const parts: HarnessStreamPart[] = [];
    const { ctx, runState } = await makeCtx('rd01b', (p) => parts.push(p));

    await hostLoop({
      agent,
      run: runState,
      driver: fakeDriver({
        text: '',
        control: { type: 'enterFlow', flowName: 'book' },
      }),
      ctx,
      classify,
    });

    expect(classifyCalls).toBe(0);
    const guardEvt = hostGuardEvents(parts)[0];
    expect(guardEvt?.data).toMatchObject({ invoked: false, reason: 'main-control' });
  });

  it('RD-01: empty turn calls classifier once and routes', async () => {
    const agent = flowAgent();
    let classifyCalls = 0;
    const classify = async (): Promise<HostGuardVerdict> => {
      classifyCalls += 1;
      return { action: 'enterFlow', flowName: 'book', confidence: 1 };
    };
    const parts: HarnessStreamPart[] = [];
    const { ctx, runState } = await makeCtx('rd01c', (p) => parts.push(p));

    const result = await hostLoop({
      agent,
      run: runState,
      driver: fakeDriver({ text: '' }),
      ctx,
      classify,
    });

    expect(classifyCalls).toBe(1);
    expect(result.kind).toBe('turnComplete');
    expect(runState.state.__completedFlows).toContain('book');
    const guardEvt = hostGuardEvents(parts)[0];
    expect(guardEvt?.data).toMatchObject({
      invoked: true,
      reason: 'empty-routed',
      verdict: 'enterFlow',
    });
  });

  it('RD-04 characterization: filler "Sure." still suppresses guard route (RD-08 deferred)', async () => {
    const agent = flowAgent();
    const classify = async (): Promise<HostGuardVerdict> => ({
      action: 'enterFlow',
      flowName: 'book',
      confidence: 1,
    });
    const { ctx, runState } = await makeCtx('rd04');

    const result = await hostLoop({
      agent,
      run: runState,
      driver: fakeDriver({ text: 'Sure.' }),
      ctx,
      classify,
    });

    // Predicate-level limitation: any trimmed text counts as answered → no guard call.
    expect(result.kind).toBe('turnComplete');
    expect(runState.activeFlow).toBeUndefined();
    const assistant = runState.messages.filter((m) => m.role === 'assistant');
    expect(assistant.at(-1)?.content).toBe('Sure.');
  });

  it('RD-04: enter_flow and transfer_to_agent descriptions forbid filler-before-control', async () => {
    const end = reply({ id: 'e', instructions: 'x', next: () => ({ end: 'ok' }) });
    const flow = defineFlow({ name: 'book', description: 'Book', start: end, nodes: [end] });
    const child = defineAgent({ id: 'billing', description: 'Billing', model: stubModel });
    const agent = defineAgent({
      id: 'host',
      flows: [flow],
      routes: [{ agent: 'billing', when: 'billing' }],
      agents: [child],
      model: stubModel,
    });
    const { runState } = await setupDurableHarness('rd04-tools', 'rd04-tools');
    const node = buildAgentReplyNode(agent, runState);
    const tools = buildHostControlTools(agent, runState);

    expect(tools.enter_flow.description).toMatch(/INSTEAD of answering/i);
    expect(tools.transfer_to_agent.description).toMatch(/INSTEAD of answering/i);
    expect(tools.transfer_to_agent.description).toMatch(/filler/i);
    expect(node.instructions).toMatch(/do not first say a filler/i);
  });

  it('RD-01: guard runs EXACTLY ONCE on an empty STREAMING turn (single owner)', async () => {
    const { mock, afterEach } = await import('bun:test');
    afterEach(() => mock.restore());
    // Empty streaming turn → the driver (TextDriver) emits nothing and hostLoop
    // runs the guard. The guard must NOT also fire inside the streaming gate
    // (the two-owner double-call this fix removed).
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: () => ({
          fullStream: (async function* () {})(),
          finishReason: Promise.resolve('stop'),
          response: Promise.resolve({ messages: [] }),
          toolCalls: Promise.resolve([]),
        }),
      };
    });
    const agent = flowAgent();
    let classifyCalls = 0;
    const classify = async (): Promise<HostGuardVerdict> => {
      classifyCalls += 1;
      return { action: 'enterFlow', flowName: 'book', confidence: 1 };
    };
    const { ctx, runState } = await makeCtx('rd01-stream');

    await hostLoop({ agent, run: runState, driver: new TextDriver(), ctx, classify });

    expect(classifyCalls).toBe(1);
    expect(runState.state.__completedFlows).toContain('book');
  });
});
