import { describe, expect, it } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { openRun, sessionDerivedRunId } from '../../src/runtime/openRun.js';
import { peekPendingUserInput } from '../../src/runtime/channels/inputBuffer.js';
import { makeRunState, makeTestSession, stubModel } from './helpers.js';

const defaultAgentId = 'agent-1';

function agentsMap() {
  const agent = defineAgent({ id: defaultAgentId, model: stubModel });
  return new Map([[agent.id, agent]]);
}

function openRunOpts(
  sessionStore: MemoryStore,
  sessionId: string,
  extra: Omit<Parameters<typeof openRun>[1], 'defaultAgentId' | 'sessionStore' | 'sessionId'>,
) {
  return {
    sessionId,
    defaultAgentId,
    sessionStore,
    ...extra,
  };
}

async function seedRun(
  memoryStore: MemoryStore,
  sessionId: string,
  runState: ReturnType<typeof makeRunState>,
) {
  const session = makeTestSession(sessionId);
  await memoryStore.save(session);
  const runStore = new SessionRunStore(memoryStore, sessionId);
  await runStore.initRun(runState);
  return runStore;
}

describe('RunOptions.selection propagation', () => {
  it('selection_formdata_lands_in_flow_state', async () => {
    const sessionId = 'sel-form-sess';
    const memoryStore = new MemoryStore();
    const agents = agentsMap();
    const runId = sessionDerivedRunId(sessionId);

    const runState = makeRunState(sessionId, runId);
    runState.state = { existing: true };
    const runStore = await seedRun(memoryStore, sessionId, runState);

    await openRun(
      agents,
      openRunOpts(memoryStore, sessionId, {
        selection: { formData: { cart: 2, addr: 'Home' } },
      }),
    );

    const persisted = await runStore.getRunState(runId);
    expect(persisted?.state).toEqual({ existing: true, cart: 2, addr: 'Home' });
  });

  it('selection_id_is_routing_input', async () => {
    const memoryStore = new MemoryStore();
    const agents = agentsMap();

    const noFlowSessionId = 'sel-id-sess';
    const noFlowOpened = await openRun(
      agents,
      openRunOpts(memoryStore, noFlowSessionId, {
        selection: { id: 'RESUME' },
      }),
    );
    expect(noFlowOpened.runState.messages.at(-1)).toEqual({
      role: 'user',
      content: 'RESUME',
    });

    const flowSessionId = 'sel-id-flow-sess';
    const runId = sessionDerivedRunId(flowSessionId);
    const runState = makeRunState(flowSessionId, runId);
    runState.activeFlow = 'checkout';
    await seedRun(memoryStore, flowSessionId, runState);

    const flowOpened = await openRun(
      agents,
      openRunOpts(memoryStore, flowSessionId, {
        selection: { id: 'RESUME' },
      }),
    );
    expect(flowOpened.runState.messages).toHaveLength(0);
    const sessionAfter = (await memoryStore.get(flowSessionId))!;
    expect(peekPendingUserInput(sessionAfter)).toBe('RESUME');
  });

  it('selection_replay_safe', async () => {
    const sessionId = 'sel-replay-sess';
    const memoryStore = new MemoryStore();
    const agents = agentsMap();
    const runId = sessionDerivedRunId(sessionId);
    const selection = { formData: { cart: 2, tier: 'gold' } };

    await openRun(agents, openRunOpts(memoryStore, sessionId, { selection }));

    await openRun(agents, openRunOpts(memoryStore, sessionId, { selection }));

    const runStore = new SessionRunStore(memoryStore, sessionId);
    const persisted = await runStore.getRunState(runId);

    expect(persisted?.state).toEqual({ cart: 2, tier: 'gold' });
  });
});
