import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { collect, defineFlow, reply } from '../../src/types/flow.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { sessionDerivedRunId } from '../../src/runtime/openRun.js';
import { stubModel } from '../core-durable/helpers.js';
import type { HostSelection } from '../../src/runtime/select.js';
import type { ChannelDriver } from '../../src/types/channel.js';

describe('RunState continuity across Runtime.run calls', () => {
  it('restores activeAgentId, activeNode, and flow position after mid-flow turn boundary', async () => {
    const confirm = reply({
      id: 'confirm',
      instructions: 'Confirm the name briefly',
      next: () => ({ end: 'done' }),
    });

    const nameCollect = collect({
      id: 'name',
      schema: z.object({ name: z.string().min(1) }),
      required: ['name'],
      maxTurns: 5,
      instructions: () => 'Ask for the user name in one short question.',
      onComplete: () => confirm,
    });

    const flow = defineFlow({
      name: 'name-intake',
      description: 'Collect a name',
      start: nameCollect,
      nodes: [nameCollect, confirm],
    });

    const agent = defineAgent({
      id: 'support',
      flows: [flow],
      model: stubModel,
    });

    const sessionStore = new MemoryStore();
    const sessionId = 'continuity-sess';
    const runId = sessionDerivedRunId(sessionId);

    let agentTurn = 0;
    const hostSelect = async (): Promise<HostSelection> => ({ kind: 'enterFlow', flow });

    const driver: ChannelDriver = {
      async runAgentTurn() {
        agentTurn += 1;
        if (agentTurn === 1) {
          return { text: 'What is your name?', toolResults: [] };
        }
        return {
          text: 'Thanks, Jordan.',
          toolResults: [
            {
              name: 'submit_name_data',
              args: { name: 'Jordan' },
              result: { name: 'Jordan' },
            },
          ],
        };
      },
      async awaitUser() {
        return { type: 'message', input: 'Jordan' };
      },
    };

    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: 'support',
      sessionStore,
      defaultModel: stubModel,
      hostSelect,
    });

    await runtime.run({
      sessionId,
      input: 'I want to give my name',
      driver,
    });

    const runStore = new SessionRunStore(sessionStore, sessionId);
    const afterTurn1 = await runStore.getRunState(runId);
    expect(afterTurn1?.activeAgentId).toBe('support');
    expect(afterTurn1?.activeFlow).toBe('name-intake');
    expect(afterTurn1?.activeNode).toBe('name');
    expect(afterTurn1?.status).toBe('running');

    const handle2 = runtime.run({
      sessionId,
      input: 'Jordan',
      driver,
    });
    await handle2;

    const afterTurn2 = await runStore.getRunState(runId);
    expect(afterTurn2?.activeAgentId).toBe('support');
    expect(afterTurn2?.state?.['__collect_name']).toEqual({ name: 'Jordan' });
  });
});
