// FINDING 9 (FIXED): completed flows are excluded within a logical run but cleared on a fresh logical run — repeat business is allowed across independent user requests | anchor src/runtime/openRun.ts:104-112, src/runtime/hostControlTools.ts:14-21, src/runtime/select.ts:56-61, src/runtime/hostLoop.ts:147-151 | proves within-run exclusion holds and fresh-run re-entry works
import { describe, expect, it } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { action, defineFlow, reply } from '../../src/types/flow.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { openRun, sessionDerivedRunId } from '../../src/runtime/openRun.js';
import type { AgentConfig } from '../../src/types/agentConfig.js';
import { availableHostFlows } from '../../src/runtime/hostControlTools.js';
import { hostLoop } from '../../src/runtime/hostLoop.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setupDurableHarness } from '../core-durable/helpers.js';
import { makeRunState, makeTestSession, stubModel } from '../core-durable/helpers.js';

describe('F9: completed flows are repeatable per logical run (FIXED)', () => {
  it('availableHostFlows excludes a completed flow within the same logical run', () => {
    const orderFlow = { name: 'order', description: 'Place an order', nodes: [], start: 's' };
    const agent = { id: 'a', flows: [orderFlow] } as unknown as AgentConfig;

    const run = makeRunState('sess-1', 'sess-1');
    expect(availableHostFlows(agent, run).map((f) => f.name)).toEqual(['order']);

    // First order completes (hostLoop appends the flow name).
    run.state.__completedFlows = ['order'];

    // Within the same logical run the flow stays excluded from guard + enter_flow.
    expect(availableHostFlows(agent, run)).toEqual([]);
  });

  it('fresh logical run clears __completedFlows so the flow is available again', async () => {
    const start = reply({ id: 'order-start', instructions: 'x', next: () => ({ end: 'ok' }) });
    const orderFlow = defineFlow({ name: 'order', description: 'Place an order', start, nodes: [start] });
    const agent = defineAgent({ id: 'agent-1', model: stubModel, flows: [orderFlow] });
    const agents = new Map([[agent.id, agent]]);

    const sessionId = 'f9-repeat-sess';
    const memoryStore = new MemoryStore();
    const runId = sessionDerivedRunId(sessionId);

    const runState = makeRunState(sessionId, runId);
    runState.state.__completedFlows = ['order'];
    const session = makeTestSession(sessionId);
    await memoryStore.save(session);
    const runStore = new SessionRunStore(memoryStore, sessionId);
    await runStore.initRun(runState);

    const result = await openRun(agents, {
      sessionId,
      defaultAgentId: agent.id,
      sessionStore: memoryStore,
      input: 'I want to order again',
    });

    expect(result.runState.state.__completedFlows).toEqual([]);
    expect(availableHostFlows(agent, result.runState).map((f) => f.name)).toEqual(['order']);
  });
});
/**
 * A flow that ENDED BECAUSE A NODE THREW is not a completed flow.
 *
 * hostLoop used to append the flow name to `__completedFlows` on any `ended` result,
 * including the `error_degraded` end that `degradeFlowError` produces. Because
 * `availableHostFlows` and `select` both exclude a completed flow from re-entry, a failed
 * intake became permanently unavailable for the rest of the logical run — even when the
 * error was trivially recoverable (a mistyped id, a transient tool fault).
 *
 * Observed live: a session persisted `__completedFlows: ["raise_work_order"]` alongside an
 * errored journal step and no work order, and the user could not retry.
 */
describe('a flow that errored is not marked completed', () => {
  it('leaves an error_degraded flow available for re-entry', async () => {
    const boom = action({
      id: 'boom',
      run: async () => {
        throw new Error('transient vendor API failure');
      },
    });
    const flow = defineFlow({
      name: 'raise_work_order',
      description: 'Raise a work order',
      start: boom,
      nodes: [boom],
    });
    const agent = defineAgent({ id: 'pm', model: stubModel, flows: [flow] });

    const { session, runStore, runState } = await setupDurableHarness(
      'degraded-not-completed',
      'degraded-not-completed-run',
    );

    const driver = {
      async runAgentTurn() {
        return { text: 'ok', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'continue' };
      },
    };
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
    });

    // hostLoop, not runFlow: the completed-flow marking lives in hostLoop, and it is the
    // path that clears activeFlow afterwards.
    runState.activeFlow = flow.name;
    const result = await hostLoop({ agent, run: runState, driver, ctx });
    expect(result).toEqual({ kind: 'turnComplete' });

    // The guard hostLoop consults: a degraded flow must still be offered.
    const completed = (runState.state.__completedFlows ?? []) as string[];
    expect(completed).not.toContain(flow.name);
    expect(availableHostFlows(agent, runState).map((f) => f.name)).toContain(flow.name);
  });
});
