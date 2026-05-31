/**
 * Live durable approval smoke — pause, persist, resume exactly-once.
 * Run: bun run smoke:approval
 */
import { describe, expect, it } from 'bun:test';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { action, defineFlow, reply } from '../../src/types/flow.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { sessionDerivedRunId } from '../../src/runtime/openRun.js';
import { defineTool } from '../../src/tools/effect/defineTool.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { liveModel } from '../helpers/liveModel.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';
import type { HostSelection } from '../../src/runtime/select.js';

const lm = liveModel();
const describeLive = lm ? describe : describe.skip;

describeLive(`core-v2 durable approval smoke (${lm?.label ?? 'no live key'})`, () => {
  it('suspends on approve, resumes once, and fires post-approval tool exactly once', async () => {
    const model = lm!.model;
    const chargeSpy = { count: 0 };

    const chargeTool = defineTool({
      name: 'charge',
      description: 'Charge the customer account',
      execute: async () => {
        chargeSpy.count += 1;
        return { charged: true, amount: 10 };
      },
    });

    const done = reply({
      id: 'done',
      instructions: 'Confirm the charge succeeded in one short sentence.',
      model,
      next: () => ({ end: 'completed' }),
    });

    const approval = action({
      id: 'approve-charge',
      run: async (_state, ctx) => {
        const decision = await ctx.approve({ title: 'Charge $10?', description: 'Customer approved verbally.' });
        if (!decision.approved) {
          return { handoff: 'human', reason: 'declined' };
        }
        await ctx.tool('charge', { amount: 10 });
        return done;
      },
    });

    const ask = reply({
      id: 'ask',
      instructions:
        'Ask one short question confirming the customer wants a $10 charge. Do not charge yet.',
      model,
      next: () => approval,
    });

    const flow = defineFlow({
      name: 'charge-flow',
      description: 'Approval-gated charge',
      start: ask,
      nodes: [ask, approval, done],
    });

    const agent = defineAgent({
      id: 'billing',
      flows: [flow],
      model,
      effectTools: { charge: chargeTool },
    });

    const sessionStore = new MemoryStore();
    const sessionId = `approval-live-${Date.now()}`;
    const runId = sessionDerivedRunId(sessionId);
    const hostSelect = async (): Promise<HostSelection> => ({ kind: 'enterFlow', flow });

    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: 'billing',
      sessionStore,
      defaultModel: model,
      hostSelect,
    });

    const parts1: HarnessStreamPart[] = [];
    const handle1 = runtime.run({
      sessionId,
      input: 'Yes, please charge ten dollars to my account.',
      driver: new TextDriver(),
    });
    for await (const part of handle1.events) {
      parts1.push(part);
    }
    await handle1;

    const runStore = new SessionRunStore(sessionStore, sessionId);
    const pausedState = await runStore.getRunState(runId);
    expect(pausedState?.status).toBe('paused');
    expect(pausedState?.waitingFor?.signalName).toBe('__approval');
    expect(chargeSpy.count).toBe(0);
    expect(parts1.some((part) => part.type === 'paused' && part.waitingFor === '__approval')).toBe(true);

    const stepsBeforeResume = await runStore.getSteps(runId);
    expect(stepsBeforeResume.filter((step) => step.kind === 'tool' && step.name === 'charge')).toHaveLength(0);

    const parts2: HarnessStreamPart[] = [];
    const handle2 = runtime.run({
      sessionId,
      signalDelivery: {
        signalId: `sig-approval-${sessionId}`,
        name: '__approval',
        payload: { approved: true, by: 'supervisor' },
      },
      driver: new TextDriver(),
    });
    for await (const part of handle2.events) {
      parts2.push(part);
    }
    await handle2;

    const resumedState = await runStore.getRunState(runId);
    expect(resumedState?.status).toBe('running');
    expect(resumedState?.waitingFor).toBeUndefined();
    expect(chargeSpy.count).toBe(1);

    const chargeSteps = (await runStore.getSteps(runId)).filter(
      (step) => step.kind === 'tool' && step.name === 'charge',
    );
    expect(chargeSteps).toHaveLength(1);

    const transcript = [...parts1, ...parts2]
      .filter((part): part is Extract<HarnessStreamPart, { type: 'text-delta' }> => part.type === 'text-delta')
      .map((part) => part.text)
      .join('');
    expect(transcript.length).toBeGreaterThan(0);
  });
});
