import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { action, defineFlow } from '../../src/types/flow.js';
import { createRuntime, HELD_FOR_HUMAN_MESSAGE } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { defineTool } from '../../src/tools/effect/index.js';
import { stubModel } from '../core-durable/helpers.js';
import type { ChannelDriver } from '../../src/types/channel.js';
import type { HostSelection } from '../../src/runtime/select.js';
import type { StreamPart, TurnHandle } from '../../src/types/stream.js';

async function collectParts(handle: TurnHandle): Promise<{ parts: StreamPart[]; text: string }> {
  const parts: StreamPart[] = [];
  let text = '';
  for await (const part of handle.events) {
    parts.push(part);
    if (part.type === 'text-delta') text += part.payload.delta;
  }
  const res = await handle;
  // Stub drivers return text without streaming text-deltas; fall back to the result text.
  if (!text && typeof (res as { text?: string }).text === 'string') {
    text = (res as { text: string }).text;
  }
  return { parts, text };
}

describe('REQ-B7: a held run does not re-run the agent until resumed', () => {
  it('escalate → next turn held (agent does not run) → resume → agent answers again', async () => {
    const sessionStore = new MemoryStore();
    let agentCalls = 0;
    const driver: ChannelDriver = {
      async runAgentTurn() {
        agentCalls += 1;
        // Turn 1 escalates; any later run answers normally.
        if (agentCalls === 1) {
          return { text: '', toolResults: [], control: { type: 'escalate', reason: 'need human' } };
        }
        return { text: 'All sorted now.', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: '' };
      },
    };

    const runtime = createRuntime({
      agents: [defineAgent({ id: 'a', instructions: 'help', model: stubModel, handoffs: ['human'] })],
      defaultAgentId: 'a',
      sessionStore,
      defaultModel: stubModel,
    });

    // Turn 1: the agent escalates → terminal handoff parks the run.
    const t1 = await collectParts(runtime.run({ sessionId: 'h', input: 'I need a human', driver }));
    expect(agentCalls).toBe(1);
    expect(t1.parts.some((p) => p.type === 'handoff' && p.payload.targetAgent === 'human')).toBe(true);
    const runStore = new SessionRunStore(sessionStore, 'h');
    let rs = (await runStore.getRunState('h'))!;
    expect(rs.status).toBe('paused');
    expect(rs.waitingFor).toBeUndefined(); // the discriminator: terminal-handoff pause has NO waitingFor

    // Turn 2: an unrelated message while held. The agent must NOT run; the user gets the
    // hold message and a valid `done` so TurnHandle consumers do not hang.
    const beforeCalls = agentCalls;
    const t2 = await collectParts(
      runtime.run({ sessionId: 'h', input: 'ok forget that. what is a good recipe for carbonara?', driver }),
    );
    expect(agentCalls).toBe(beforeCalls); // agent did not run
    expect(t2.text).toBe(HELD_FOR_HUMAN_MESSAGE);
    expect(t2.parts.some((p) => p.type === 'done')).toBe(true);
    expect(t2.parts.some((p) => p.type === 'handoff')).toBe(false); // not re-escalated
    rs = (await runStore.getRunState('h'))!;
    expect(rs.status).toBe('paused'); // still held
    // The held turn still recorded the user's inbound message for the human/resume to see.
    expect(rs.messages.some((m) => m.role === 'user' && String(m.content).includes('carbonara'))).toBe(true);

    // Resume hands control back to the bot.
    await runtime.resumeFromEscalation('h', { resolutionSummary: 'Handled offline.' });
    rs = (await runStore.getRunState('h'))!;
    expect(rs.status).toBe('running');
    expect(rs.waitingFor).toBeUndefined();

    // Turn 3: the agent runs again and answers.
    const t3 = await collectParts(runtime.run({ sessionId: 'h', input: 'thanks, what now?', driver }));
    expect(agentCalls).toBe(2);
    expect(t3.text).toContain('All sorted now.');
  });
});

describe('REQ-B2: a run parked on approval/suspend is NOT held', () => {
  it('a message arriving during a pending approval is not gated (waitingFor is set)', async () => {
    const sessionStore = new MemoryStore();
    let execCount = 0;
    const needsHuman = defineTool({
      name: 'needs_human',
      description: 'x',
      input: z.object({}),
      needsApproval: true,
      execute: async () => {
        execCount += 1;
        return { ok: true };
      },
    });
    const act = action({
      id: 'act',
      run: async (_state, ctx) => {
        await ctx.tool('needs_human', {});
        return { end: 'done' };
      },
    });
    const flow = defineFlow({ name: 'approve-flow', description: 'x', start: act, nodes: [act] });
    const agent = defineAgent({ id: 'a', instructions: 'help', flows: [flow], model: stubModel });

    const driver: ChannelDriver = {
      async runAgentTurn() {
        return { text: '', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: '' };
      },
    };

    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: 'a',
      sessionStore,
      defaultModel: stubModel,
      tools: { needs_human: needsHuman },
      hostSelect: async (): Promise<HostSelection> => ({ kind: 'enterFlow', flow }),
    });

    const runStore = new SessionRunStore(sessionStore, 'ap');

    // Turn 1: enter the flow → action → needsApproval tool suspends.
    await collectParts(runtime.run({ sessionId: 'ap', input: 'go', driver }));
    expect(execCount).toBe(0);
    const paused = (await runStore.getRunState('ap'))!;
    expect(paused.status).toBe('paused');
    expect(paused.waitingFor?.signalName).toBe('__approval'); // waitingFor IS set

    // Turn 2: a message arrives while approval is still pending — NO signal delivered.
    // This is the at-risk case: gating on `status === 'paused'` alone would hold it and
    // hang every pending approval. The correct gate (`paused && !waitingFor`) lets it run;
    // the flow resumes, re-meets the still-pending approval, and re-pauses on __approval.
    const t2 = await collectParts(runtime.run({ sessionId: 'ap', input: 'any update?', driver }));
    expect(t2.text).not.toBe(HELD_FOR_HUMAN_MESSAGE); // NOT held
    expect(t2.parts.some((p) => p.type === 'text-delta' && p.payload.delta === HELD_FOR_HUMAN_MESSAGE)).toBe(false);
    expect(execCount).toBe(0); // still pending — the tool has not run
    const stillPending = (await runStore.getRunState('ap'))!;
    expect(stillPending.status).toBe('paused');
    expect(stillPending.waitingFor?.signalName).toBe('__approval'); // re-parked on the approval

    // Turn 3: deliver the approval — the tool now runs and the flow completes.
    const t3 = await collectParts(
      runtime.run({
        sessionId: 'ap',
        signalDelivery: {
          signalId: `cli-${Date.now()}`,
          requestId: stillPending.waitingFor!.requestId,
          name: '__approval',
          actor: { id: 'mgr', type: 'user' },
          decision: 'approve',
        },
        driver,
      }),
    );
    expect(execCount).toBe(1);
    expect(t3.parts.some((p) => p.type === 'done')).toBe(true);
  });
});
