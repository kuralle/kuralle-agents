import { describe, expect, test } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import type { ChannelDriver } from '../../src/types/channel.js';
import { stubModel } from '../core-durable/helpers.js';

function driver(runAgentTurn: ChannelDriver['runAgentTurn']): ChannelDriver {
  return {
    runAgentTurn,
    async awaitUser() {
      return { type: 'message', input: 'next' };
    },
  };
}

describe('runtime working-memory persistence', () => {
  test('persists values added and deleted through the live run context', async () => {
    const store = new MemoryStore();
    const runtime = createRuntime({
      agents: [defineAgent({ id: 'agent', instructions: 'Help.', model: stubModel })],
      defaultAgentId: 'agent',
      defaultModel: stubModel,
      sessionStore: store,
    });
    const sessionId = 'working-memory-persistence';

    await runtime.run({
      sessionId,
      input: 'authenticate',
      driver: driver(async (_node, ctx) => {
        ctx.session.workingMemory.authenticatedPatientId = 'patient-1';
        ctx.session.workingMemory.removeMe = true;
        return { text: 'authenticated', toolResults: [] };
      }),
    });

    expect((await store.get(sessionId))?.workingMemory).toEqual({
      authenticatedPatientId: 'patient-1',
      removeMe: true,
    });

    let observed: unknown;
    await runtime.run({
      sessionId,
      input: 'continue',
      driver: driver(async (_node, ctx) => {
        observed = ctx.session.workingMemory.authenticatedPatientId;
        delete ctx.session.workingMemory.removeMe;
        return { text: 'continued', toolResults: [] };
      }),
    });

    expect(observed).toBe('patient-1');
    expect((await store.get(sessionId))?.workingMemory).toEqual({
      authenticatedPatientId: 'patient-1',
    });
  });
});
