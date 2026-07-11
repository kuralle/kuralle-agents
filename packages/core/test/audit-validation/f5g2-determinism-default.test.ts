// F5/G2: flow agents default outOfBandControl ON; answering agents stay OFF; classifier sees conversation context.
import { describe, expect, it, mock, afterEach } from 'bun:test';
import type { LanguageModel } from 'ai';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { defineFlow, reply } from '../../src/types/flow.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { classifyHostTarget, formatRecentConversation } from '../../src/runtime/select.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { getFlowPark } from '../../src/flow/collectDigression.js';
import { setPendingUserInput } from '../../src/runtime/channels/inputBuffer.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import type { HostSelection } from '../../src/runtime/select.js';
import type { ChannelDriver } from '../../src/types/channel.js';
import type { RunContext } from '../../src/types/run-context.js';

const stubDriver: ChannelDriver = {
  async runAgentTurn() {
    return { text: 'ok', toolResults: [] };
  },
  async awaitUser() {
    return { type: 'message', input: 'x' };
  },
};

afterEach(() => mock.restore());

function minimalFlow(name = 'intake') {
  const done = reply({ id: 'done', instructions: 'Thanks.', next: () => ({ end: 'done' }) });
  return defineFlow({ name, description: 'Collect intake', start: done, nodes: [done] });
}

async function captureOutOfBandAtRunOpen(
  agentId: string,
  agents: ReturnType<typeof defineAgent>[],
  hostSelect: () => Promise<HostSelection>,
) {
  let captured: boolean | undefined;
  const sessionStore = new MemoryStore();
  const runtime = createRuntime({
    agents,
    defaultAgentId: agentId,
    sessionStore,
    defaultModel: stubModel,
    hooks: {
      onStart: (ctx: RunContext) => {
        captured = ctx.outOfBandControl;
      },
    },
    hostSelect,
  });

  const handle = runtime.run({
    sessionId: `f5g2-${agentId}`,
    input: 'hello',
    driver: stubDriver,
  });
  for await (const _ of handle.events) {
    // drain
  }
  await handle;
  return captured;
}

describe('F5/G2: determinism defaults and routing context', () => {
  it('flow agent without explicit experimental.outOfBandControl resolves outOfBandControl true at run-open', async () => {
    const flow = minimalFlow();
    const flowAgent = defineAgent({
      id: 'flow-agent',
      instructions: 'Run the intake flow.',
      model: stubModel,
      flows: [flow],
    });

    const resolved = await captureOutOfBandAtRunOpen(
      'flow-agent',
      [flowAgent],
      async () => ({ kind: 'enterFlow', flow }),
    );
    expect(resolved).toBe(true);
  });

  it('non-flow answering agent resolves outOfBandControl false at run-open', async () => {
    const answeringAgent = defineAgent({
      id: 'answering',
      instructions: 'Answer freely.',
      model: stubModel,
    });

    const resolved = await captureOutOfBandAtRunOpen(
      'answering',
      [answeringAgent],
      async () => ({ kind: 'keep' }),
    );
    expect(resolved).toBe(false);
  });

  it('routing classifier receives multi-message context when history has prior turns', async () => {
    let capturedPrompt = '';
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        generateObject: async (opts: { prompt?: string }) => {
          capturedPrompt = opts.prompt ?? '';
          return {
            object: {
              action: 'enterFlow',
              flowName: 'home-insurance',
              agentId: null,
              reason: 'home policy continuation',
              confidence: 0.95,
            },
          };
        },
      };
    });

    const end = reply({ id: 'end', instructions: 'done', next: () => ({ end: 'ok' }) });
    const home = defineFlow({
      name: 'home-insurance',
      description: 'Home insurance policies',
      start: end,
      nodes: [end],
    });
    const auto = defineFlow({
      name: 'auto-insurance',
      description: 'Auto insurance policies',
      start: end,
      nodes: [end],
    });

    const { runState } = await setupDurableHarness('f5g2-ctx', 'f5g2-ctx-run');
    runState.messages = [
      { role: 'user', content: 'I need a home insurance quote' },
      { role: 'assistant', content: 'I can help with home coverage.' },
      { role: 'user', content: 'and the home one too' },
    ];

    const recent = formatRecentConversation(runState.messages);
    expect(recent.split('\n').length).toBeGreaterThan(1);

    const result = await classifyHostTarget({
      agent: {
        id: 'router',
        flows: [home, auto],
        routes: [
          { flow: 'home-insurance', when: 'home property dwelling' },
          { flow: 'auto-insurance', when: 'car vehicle auto' },
        ],
      },
      run: runState,
      model: {} as LanguageModel,
      allowKeep: true,
    });

    expect(capturedPrompt).toContain('Recent conversation:');
    expect(capturedPrompt).toContain('home insurance');
    expect(capturedPrompt).toContain('and the home one too');
    expect(result.action).toBe('enterFlow');
    expect(result.flowName).toBe('home-insurance');
  });

  it('pivot during a reply node is recognized and parked via pushFlowPark', async () => {
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        generateObject: async () => ({
          object: {
            action: 'enterFlow',
            flowName: 'billing',
            agentId: null,
            reason: 'billing',
            confidence: 0.95,
          },
        }),
      };
    });

    const greet = reply({ id: 'greet', instructions: 'Welcome! How can I help?' });
    const intake = defineFlow({
      name: 'intake',
      description: 'General intake',
      start: greet,
      nodes: [greet],
    });
    const billingHold = reply({ id: 'bill-reply', instructions: 'Billing help.' });
    const billing = defineFlow({
      name: 'billing',
      description: 'Billing questions',
      start: billingHold,
      nodes: [billingHold],
    });

    const agent = defineAgent({
      id: 'router',
      model: stubModel,
      flows: [intake, billing],
      routes: [{ flow: 'billing', when: 'billing invoice payment' }],
    });

    const { session, runStore, runState } = await setupDurableHarness('f5g2-reply-pivot', 'f5g2-reply-pivot-run');
    runState.messages = [{ role: 'user', content: 'billing invoice help' }];
    runState.activeFlow = intake.name;
    runState.activeNode = greet.id;
    setPendingUserInput(session, 'billing invoice help');

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: { execute: async () => ({}) },
      model: stubModel,
      emit: () => {},
      outOfBandControl: true,
    });

    const driver = {
      async runAgentTurn() {
        return { text: 'Should not speak over pivot.', toolResults: [] };
      },
      async awaitUser(c: RunContext) {
        const { consumePendingUserInput } = await import('../../src/runtime/channels/inputBuffer.js');
        return { type: 'message' as const, input: consumePendingUserInput(c.session) ?? '' };
      },
    };

    const result = await runFlow(intake, runState, driver, ctx, agent);

    expect(result.kind).not.toBe('ended');
    expect(runState.activeFlow).toBe('billing');
    expect(getFlowPark(runState.state)).toEqual({ flow: 'intake', node: 'greet' });
  });
});