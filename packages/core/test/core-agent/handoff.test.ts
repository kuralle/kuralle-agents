import { describe, expect, it } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { sessionDerivedRunId } from '../../src/runtime/openRun.js';
import { stubModel } from '../core-durable/helpers.js';
import type { HostSelection } from '../../src/runtime/select.js';
import type { ChannelDriver } from '../../src/types/channel.js';

describe('sticky cross-agent handoff', () => {
  it('pins activeAgentId to the handoff target across separate run calls', async () => {
    const agentB = defineAgent({
      id: 'billing',
      instructions: 'You are the billing specialist. Mention billing in your reply.',
      model: stubModel,
    });

    const agentA = defineAgent({
      id: 'support',
      routes: [{ agent: 'billing', when: 'billing or payment questions' }],
      agents: [agentB],
      model: stubModel,
    });

    const sessionStore = new MemoryStore();
    const sessionId = 'handoff-sess';
    const runId = sessionDerivedRunId(sessionId);

    let calls = 0;
    const hostSelect = async (): Promise<HostSelection> => {
      calls += 1;
      if (calls === 1) {
        return { kind: 'route', agentId: 'billing', reason: 'billing' };
      }
      return { kind: 'keep' };
    };

    const driver: ChannelDriver = {
      async runAgentTurn() {
        return { text: 'billing help here', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: 'more' };
      },
    };

    const runtime = createRuntime({
      agents: [agentA, agentB],
      defaultAgentId: 'support',
      sessionStore,
      defaultModel: stubModel,
      maxHandoffs: 2,
      hostSelect,
    });

    await runtime.run({
      sessionId,
      input: 'I have a billing question',
      driver,
    });

    const runStore = new SessionRunStore(sessionStore, sessionId);
    const afterHandoff = await runStore.getRunState(runId);
    expect(afterHandoff?.activeAgentId).toBe('billing');

    const handle2 = runtime.run({
      sessionId,
      input: 'Can you check invoice 42?',
      driver,
    });
    const result2 = await handle2;
    expect(result2.text.toLowerCase()).toContain('billing');

    const afterTurn2 = await runStore.getRunState(runId);
    expect(afterTurn2?.activeAgentId).toBe('billing');
    expect(calls).toBe(1);
  });

  it('throws when handoffs exceed maxHandoffs', async () => {
    const a = defineAgent({ id: 'a', routes: [{ agent: 'b', when: 'x' }], model: stubModel });
    const b = defineAgent({ id: 'b', routes: [{ agent: 'a', when: 'y' }], model: stubModel });

    let flip = 0;
    const hostSelect = async (): Promise<HostSelection> => {
      flip += 1;
      return flip % 2 === 1 ? { kind: 'route', agentId: 'b' } : { kind: 'route', agentId: 'a' };
    };

    const runtime = createRuntime({
      agents: [a, b],
      defaultAgentId: 'a',
      defaultModel: stubModel,
      maxHandoffs: 1,
      hostSelect,
    });

    const driver: ChannelDriver = {
      async runAgentTurn() {
        return { text: 'ok', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: 'x' };
      },
    };

    const handle = runtime.run({ sessionId: 'max-handoff', input: 'route me', driver });
    await expect(handle).rejects.toThrow(/maxHandoffs/);
  });
});
