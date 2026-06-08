import { describe, expect, it } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { reply, defineFlow } from '../../src/types/flow.js';
import { hostLoop } from '../../src/runtime/hostLoop.js';
import {
  deriveAgentCapabilities,
  deriveAgentShape,
  hasLocalAnsweringSurface,
} from '../../src/runtime/deriveAgent.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import type { HostGuardVerdict } from '../../src/runtime/select.js';

describe('deriveAgentShape', () => {
  it('routes-only agent is a pure dispatcher', () => {
    const agent = defineAgent({
      id: 'router',
      routes: [{ agent: 'billing', when: 'billing' }],
      model: stubModel,
    });
    const shape = deriveAgentShape(agent);
    expect(shape.isPureDispatcher).toBe(true);
    expect(shape.isAnsweringAgent).toBe(false);
    expect(hasLocalAnsweringSurface(agent)).toBe(false);
  });

  it('routes plus tools is an answering agent', () => {
    const agent = defineAgent({
      id: 'router-tools',
      routes: [{ agent: 'billing', when: 'billing' }],
      tools: {
        echo: {
          name: 'echo',
          description: 'echo',
          input: { parse: () => ({}) },
          execute: async () => ({}),
        } as never,
      },
      model: stubModel,
    });
    const shape = deriveAgentShape(agent);
    expect(shape.isAnsweringAgent).toBe(true);
    expect(shape.isPureDispatcher).toBe(false);
  });

  it('flows without instructions is an answering agent', () => {
    const end = reply({ id: 'end', instructions: 'done', next: () => ({ end: 'ok' }) });
    const flow = defineFlow({ name: 'faq', description: 'FAQ', start: end, nodes: [end] });
    const agent = defineAgent({ id: 'flowy', flows: [flow], model: stubModel });
    expect(deriveAgentShape(agent).isAnsweringAgent).toBe(true);
  });

  it('generated fallback instructions do not count as answering surface', () => {
    const agent = defineAgent({
      id: 'routes-only',
      routes: [{ agent: 'x', when: 'y' }],
      model: stubModel,
    });
    expect(hasLocalAnsweringSurface(agent)).toBe(false);
  });

  it('whitespace instructions do not count', () => {
    const agent = defineAgent({
      id: 'ws',
      instructions: '   ',
      routes: [{ agent: 'x', when: 'y' }],
      model: stubModel,
    });
    expect(hasLocalAnsweringSurface(agent)).toBe(false);
  });
});

describe('defineAgent derivation by field presence', () => {
  it('instructions-only agent runs free conversation', async () => {
    const agent = defineAgent({
      id: 'free',
      instructions: 'Say hi briefly',
      model: stubModel,
    });

    expect(deriveAgentCapabilities(agent).precedence).toBe('free');
    expect(deriveAgentShape(agent).isAnsweringAgent).toBe(true);

    let agentTurns = 0;
    const driver = {
      outputCapability: 'kuralle-controlled-text' as const,
      async runAgentTurn() {
        agentTurns += 1;
        return { text: 'hello', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'next' };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness('deriv-free', 'deriv-free');
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
    });

    await hostLoop({ agent, run: runState, driver, ctx });
    expect(agentTurns).toBe(1);
  });

  it('agent with flows can enter a flow via enter_flow control', async () => {
    const end = reply({ id: 'end', instructions: 'done', next: () => ({ end: 'ok' }) });
    const flow = defineFlow({
      name: 'faq',
      description: 'Answer FAQs',
      start: end,
      nodes: [end],
    });

    const agent = defineAgent({
      id: 'flowy',
      instructions: 'Help',
      flows: [flow],
      model: stubModel,
    });

    expect(deriveAgentCapabilities(agent).precedence).toBe('flows');

    let flowRuns = 0;
    const driver = {
      outputCapability: 'kuralle-controlled-text' as const,
      async runAgentTurn() {
        flowRuns += 1;
        return {
          text: '',
          toolResults: [],
          control: { type: 'enterFlow' as const, flowName: 'faq' },
        };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'more' };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness('deriv-flow', 'deriv-flow');
    const parts: string[] = [];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: (part) => {
        if (part.type === 'flow-enter') {
          parts.push(part.flow);
        }
      },
    });

    await hostLoop({ agent, run: runState, driver, ctx });
    expect(flowRuns).toBeGreaterThan(0);
    expect(parts).toContain('faq');
  });

  it('pure dispatcher never calls runAgentTurn', async () => {
    const agent = defineAgent({
      id: 'router',
      routes: [{ agent: 'billing', when: 'billing questions' }],
      model: stubModel,
    });

    expect(deriveAgentCapabilities(agent).precedence).toBe('routes');

    let agentTurns = 0;
    const driver = {
      outputCapability: 'kuralle-controlled-text' as const,
      async runAgentTurn() {
        agentTurns += 1;
        return { text: 'nope', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'x' };
      },
    };

    const classify = async (): Promise<HostGuardVerdict> => ({
      action: 'transfer',
      targetAgentId: 'billing',
      reason: 'billing',
    });

    const { session, runStore, runState } = await setupDurableHarness('deriv-route', 'deriv-route');
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
    });

    const result = await hostLoop({ agent, run: runState, driver, ctx, classify });
    expect(result).toEqual({ kind: 'handoff', to: 'billing', reason: 'billing' });
    expect(agentTurns).toBe(0);
  });
});
