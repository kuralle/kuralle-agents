import { describe, expect, it } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { reply, defineFlow } from '../../src/types/flow.js';
import { hostLoop } from '../../src/runtime/hostLoop.js';
import { deriveAgentCapabilities, shouldRunHostSelector } from '../../src/runtime/deriveAgent.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import type { HostSelection } from '../../src/runtime/select.js';

describe('defineAgent derivation by field presence', () => {
  it('tools-only agent skips selector and runs free conversation', async () => {
    const agent = defineAgent({
      id: 'free',
      instructions: 'Say hi briefly',
      model: stubModel,
    });

    expect(deriveAgentCapabilities(agent).precedence).toBe('free');
    expect(shouldRunHostSelector(agent)).toBe(false);

    let agentTurns = 0;
    const driver = {
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

    const select = async () => {
      throw new Error('select should not run for tools-only');
    };

    await hostLoop({ agent, run: runState, driver, ctx, select });
    expect(agentTurns).toBe(1);
  });

  it('agent with flows uses selector and can enter a flow', async () => {
    const end = reply({ id: 'end', instructions: 'done', next: () => ({ end: 'ok' }) });
    const flow = defineFlow({
      name: 'faq',
      description: 'Answer FAQs',
      start: end,
      nodes: [end],
    });

    const agent = defineAgent({
      id: 'flowy',
      flows: [flow],
      model: stubModel,
    });

    expect(deriveAgentCapabilities(agent).precedence).toBe('flows');
    expect(shouldRunHostSelector(agent)).toBe(true);

    let flowRuns = 0;
    const driver = {
      async runAgentTurn() {
        flowRuns += 1;
        return { text: 'faq answer', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'more' };
      },
    };

    const select = async (): Promise<HostSelection> => ({ kind: 'enterFlow', flow });

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

    await hostLoop({ agent, run: runState, driver, ctx, select });
    expect(flowRuns).toBeGreaterThan(0);
    expect(parts).toContain('faq');
  });

  it('agent with routes can return handoff from selector', async () => {
    const agent = defineAgent({
      id: 'router',
      routes: [{ agent: 'billing', when: 'billing questions' }],
      model: stubModel,
    });

    expect(deriveAgentCapabilities(agent).precedence).toBe('routes');

    const driver = {
      async runAgentTurn() {
        return { text: 'nope', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'x' };
      },
    };

    const select = async (): Promise<HostSelection> => ({
      kind: 'route',
      agentId: 'billing',
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

    const result = await hostLoop({ agent, run: runState, driver, ctx, select });
    expect(result).toEqual({ kind: 'handoff', to: 'billing', reason: 'billing' });
  });
});
