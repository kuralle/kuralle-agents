import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { action, defineFlow } from '../../src/types/flow.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
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

describe('G16: handoff rebuilds full agent surface', () => {
  it('target flow-action tool resolves after handoff (no Unknown tool)', async () => {
    let bToolRan = false;
    const bOnlyTool = defineTool({
      name: 'b_only_tool',
      description: 'Executor tool unique to agent B',
      input: z.object({}),
      execute: async () => {
        bToolRan = true;
        return { ok: true };
      },
    });

    const bWork = action({
      id: 'work',
      run: async (_state, ctx) => {
        await ctx.tool('b_only_tool', {});
        return { end: 'done' };
      },
    });
    const bFlow = defineFlow({
      name: 'b-flow',
      description: 'B work flow',
      start: bWork,
      nodes: [bWork],
    });

    const agentB = defineAgent({
      id: 'B',
      instructions: 'I am B',
      flows: [bFlow],
      tools: { b_only_tool: bOnlyTool },
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
      model: stubModel,
    });

    const sessionStore = new MemoryStore();
    const sessionId = 'g16-handoff-surface';
    const runId = sessionDerivedRunId(sessionId);

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

    const parts: HarnessStreamPart[] = [];
    const handle = runtime.run({ sessionId, input: 'start', driver });
    for await (const part of handle.events) {
      parts.push(part);
    }
    await handle;

    const runStore = new SessionRunStore(sessionStore, sessionId);
    const state = await runStore.getRunState(runId);
    expect(state?.activeAgentId).toBe('B');
    expect(bToolRan).toBe(true);
    expect(
      parts.some((part) => part.type === 'error' && String(part.error).includes('Unknown tool')),
    ).toBe(false);
  });
});