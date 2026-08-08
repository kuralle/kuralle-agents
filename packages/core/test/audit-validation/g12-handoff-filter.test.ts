import { describe, expect, it } from 'bun:test';
import type { ModelMessage } from 'ai';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { action, defineFlow } from '../../src/types/flow.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { removeToolHistory } from '../../src/runtime/handoffFilters.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { sessionDerivedRunId } from '../../src/runtime/openRun.js';
import { makeRunState, makeTestSession, stubModel } from '../core-durable/helpers.js';
import type { HostSelection } from '../../src/runtime/select.js';
import type { ChannelDriver } from '../../src/types/channel.js';
import type { StreamPart } from '../../src/types/stream.js';

const driver: ChannelDriver = {
  async runAgentTurn() {
    return { text: '', toolResults: [] };
  },
  async awaitUser() {
    return { type: 'message', input: 'x' };
  },
};

const seededToolHistory: ModelMessage[] = [
  { role: 'user', content: 'look up my order' },
  {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'lookup_order',
        input: {},
      },
    ],
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'lookup_order',
        output: { type: 'json', value: { orderId: '42' } },
      },
    ],
  },
];

function hasToolRoleOrCall(messages: ModelMessage[]): boolean {
  return messages.some((m) => {
    if (m.role === 'tool') return true;
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      return m.content.some(
        (part) =>
          typeof part === 'object' &&
          part !== null &&
          'type' in part &&
          (part.type === 'tool-call' || part.type === 'tool-result'),
      );
    }
    return false;
  });
}

describe('G12: handoff inputFilter', () => {
  it('removeToolHistory strips tool-role and tool-only assistant messages', () => {
    const result = removeToolHistory({
      messages: seededToolHistory,
      workingMemory: {},
      sourceAgentId: 'A',
      targetAgentId: 'B',
    });
    expect(hasToolRoleOrCall(result.messages)).toBe(false);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe('user');
  });

  it('applies route filter on handoff so target agent receives stripped history', async () => {
    let filterInvocations = 0;
    const routeFilter = (data: Parameters<typeof removeToolHistory>[0]) => {
      filterInvocations += 1;
      return removeToolHistory(data);
    };

    const bDone = action({
      id: 'done',
      run: async () => ({ end: 'ok' }),
    });
    const bFlow = defineFlow({
      name: 'b-flow',
      description: 'B completes',
      start: bDone,
      nodes: [bDone],
    });

    const agentB = defineAgent({
      id: 'B',
      instructions: 'I am B',
      flows: [bFlow],
      model: stubModel,
    });

    const handoffNode = action({
      id: 'handoff',
      run: async () => ({ handoff: 'B', reason: 'to B' }),
    });
    const aFlow = defineFlow({
      name: 'a-flow',
      description: 'A handoff flow',
      start: handoffNode,
      nodes: [handoffNode],
    });

    const agentA = defineAgent({
      id: 'A',
      instructions: 'I am A',
      flows: [aFlow],
      agents: [agentB],
      routes: [{ agent: 'B', when: 'transfer to B', filter: routeFilter }],
      model: stubModel,
    });

    const sessionStore = new MemoryStore();
    const sessionId = 'g12-handoff-filter';
    const runId = sessionDerivedRunId(sessionId);

    const session = makeTestSession(sessionId);
    session.currentAgent = 'A';
    session.activeAgentId = 'A';
    session.messages = [...seededToolHistory];
    await sessionStore.save(session);

    const runStoreSeed = new SessionRunStore(sessionStore, sessionId);
    const runState = makeRunState(sessionId, runId);
    runState.activeAgentId = 'A';
    runState.messages = [...seededToolHistory];
    await runStoreSeed.initRun(runState);

    const hostSelect = async (): Promise<HostSelection> => {
      const runStore = new SessionRunStore(sessionStore, sessionId);
      const state = await runStore.getRunState(runId);
      if (state?.activeAgentId === 'B') {
        return { kind: 'enterFlow', flow: bFlow };
      }
      return { kind: 'enterFlow', flow: aFlow };
    };

    const runtime = createRuntime({
      agents: [agentA, agentB],
      defaultAgentId: 'A',
      sessionStore,
      defaultModel: stubModel,
      maxHandoffs: 2,
      hostSelect,
    });

    const parts: StreamPart[] = [];
    const handle = runtime.run({ sessionId, input: 'start', driver });
    for await (const part of handle.events) {
      parts.push(part);
    }
    await handle;

    const runStore = new SessionRunStore(sessionStore, sessionId);
    const state = await runStore.getRunState(runId);
    expect(state?.activeAgentId).toBe('B');
    expect(filterInvocations).toBe(1);
    expect(hasToolRoleOrCall(state?.messages ?? [])).toBe(false);
    expect(parts.some((part) => part.type === 'error')).toBe(false);
  });
});