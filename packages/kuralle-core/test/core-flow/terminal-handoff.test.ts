import { describe, expect, it } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { action, defineFlow } from '../../src/types/flow.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { sessionDerivedRunId } from '../../src/runtime/openRun.js';
import { stubModel } from '../core-durable/helpers.js';
import type { HostSelection } from '../../src/runtime/select.js';
import type { ChannelDriver } from '../../src/types/channel.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';

const driver: ChannelDriver = {
  async runAgentTurn() {
    return { text: '', toolResults: [] };
  },
  async awaitUser() {
    return { type: 'message', input: 'x' };
  },
};

describe('terminal handoff targets', () => {
  it('escalate_to_human_does_not_throw', async () => {
    const escalateNode = action({
      id: 'escalate',
      run: async () => ({ escalate: 'needs human help' }),
    });

    const flow = defineFlow({
      name: 'escalate-flow',
      description: 'Escalate to human',
      start: escalateNode,
      nodes: [escalateNode],
    });

    const agent = defineAgent({
      id: 'support',
      flows: [flow],
      model: stubModel,
    });

    const sessionStore = new MemoryStore();
    const sessionId = 'terminal-handoff-escalate';
    const runId = sessionDerivedRunId(sessionId);
    const hostSelect = async (): Promise<HostSelection> => ({ kind: 'enterFlow', flow });

    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: 'support',
      sessionStore,
      defaultModel: stubModel,
      hostSelect,
    });

    const parts1: HarnessStreamPart[] = [];
    const handle1 = runtime.run({ sessionId, input: 'help', driver });
    for await (const part of handle1.events) {
      parts1.push(part);
    }
    await handle1;

    const runStore = new SessionRunStore(sessionStore, sessionId);
    const paused = await runStore.getRunState(runId);
    expect(paused?.status).toBe('paused');
    expect(paused?.waitingFor?.signalName).toBe('__escalate');
    expect(parts1.some((part) => part.type === 'paused' && part.waitingFor === '__escalate')).toBe(true);

    const parts2: HarnessStreamPart[] = [];
    const handle2 = runtime.run({
      sessionId,
      signalDelivery: {
        signalId: `sig-escalate-${sessionId}`,
        name: '__escalate',
        payload: {},
      },
      driver,
    });
    for await (const part of handle2.events) {
      parts2.push(part);
    }
    await handle2;

    const after = await runStore.getRunState(runId);
    expect(after?.status).toBe('paused');
    expect(after?.activeAgentId).toBe('support');

    const handoffParts = parts2.filter((part) => part.type === 'handoff');
    expect(handoffParts).toHaveLength(1);
    expect(handoffParts[0]).toEqual({
      type: 'handoff',
      targetAgent: 'human',
      reason: 'needs human help',
    });
    expect(parts2.some((part) => part.type === 'done')).toBe(true);
  });

  it('direct handoff to human pauses without resolving an agent', async () => {
    const handoffNode = action({
      id: 'handoff-human',
      run: async () => ({ handoff: 'human', reason: 'operator required' }),
    });

    const flow = defineFlow({
      name: 'handoff-flow',
      description: 'Hand off to human',
      start: handoffNode,
      nodes: [handoffNode],
    });

    const agent = defineAgent({
      id: 'support',
      flows: [flow],
      model: stubModel,
    });

    const sessionStore = new MemoryStore();
    const sessionId = 'terminal-handoff-direct';
    const runId = sessionDerivedRunId(sessionId);
    const hostSelect = async (): Promise<HostSelection> => ({ kind: 'enterFlow', flow });

    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: 'support',
      sessionStore,
      defaultModel: stubModel,
      hostSelect,
    });

    const parts: HarnessStreamPart[] = [];
    const handle = runtime.run({ sessionId, input: 'hand off', driver });
    for await (const part of handle.events) {
      parts.push(part);
    }
    await handle;

    const runStore = new SessionRunStore(sessionStore, sessionId);
    const state = await runStore.getRunState(runId);
    expect(state?.status).toBe('paused');

    const handoffParts = parts.filter((part) => part.type === 'handoff');
    expect(handoffParts.length).toBeGreaterThanOrEqual(1);
    expect(handoffParts.some((part) => part.targetAgent === 'human' && part.reason === 'operator required')).toBe(
      true,
    );

    const session = await sessionStore.get(sessionId);
    expect(session?.handoffHistory).toHaveLength(0);
  });
});
