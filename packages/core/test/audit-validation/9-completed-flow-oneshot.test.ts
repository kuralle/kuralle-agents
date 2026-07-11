// FINDING 9 (FIXED): completed flows are excluded within a logical run but cleared on a fresh logical run — repeat business is allowed across independent user requests | anchor src/runtime/openRun.ts:104-112, src/runtime/hostControlTools.ts:14-21, src/runtime/select.ts:56-61, src/runtime/hostLoop.ts:147-151 | proves within-run exclusion holds and fresh-run re-entry works
import { describe, expect, it } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { defineFlow, reply } from '../../src/types/flow.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { openRun, sessionDerivedRunId } from '../../src/runtime/openRun.js';
import type { AgentConfig } from '../../src/types/agentConfig.js';
import { availableHostFlows } from '../../src/runtime/hostControlTools.js';
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