import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { collect } from '../../src/types/flow.js';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { runCollectDigression } from '../../src/flow/collectDigression.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import type { ResolvedNode } from '../../src/types/channel.js';
import type { HostSelection } from '../../src/runtime/select.js';

/**
 * A mid-flow aside ("who's the cheapest plumber?") must be ANSWERED and the flow
 * resumed — not routed away.
 *
 * `runCollectDigression` asked the host router first and only tested
 * `looksLikeOffScriptQuestion` afterwards. A router that answers `route` returns a
 * handoff before that test is ever reached, so an ordinary question abandons the
 * flow and discards everything already collected. The off-script test was
 * unreachable for that path.
 *
 * `select` is injectable, so this drives the decision deterministically — no model,
 * no network.
 */
describe('collect digression ordering', () => {
  async function harness(sessionId: string, userText: string) {
    const { session, runStore, runState } = await setupDurableHarness(sessionId, `${sessionId}-run`);
    runState.messages = [{ role: 'user', content: userText }];
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
      outOfBandControl: true,
    });
    ctx.baseInstructions = 'Answer helpfully.';

    let spoke = false;
    const driver = {
      async runAgentTurn(_node: ResolvedNode) {
        spoke = true;
        return { text: 'Bayfront Drain Co, $95.', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: '' };
      },
    };

    const agent = defineAgent({
      id: 'probe',
      model: stubModel,
      instructions: 'help',
      flows: [],
    });

    const node = collect({
      id: 'intake',
      schema: z.object({ unitId: z.string(), issue: z.string() }),
      required: ['unitId', 'issue'],
      ask: () => 'which unit and what is wrong?',
      onComplete: () => ({ end: 'done' }),
    });

    return { ctx, runState, driver, agent, node, didSpeak: () => spoke };
  }

  it('answers an off-script question and resumes, even when the router wants to route away', async () => {
    const h = await harness('digress-route', "who's the cheapest plumber?");

    // A router that always wants to hand off — exactly what was observed live,
    // where a mid-flow aside produced `handoff:human`.
    const alwaysRoutes = async (): Promise<HostSelection> => ({
      kind: 'route',
      agentId: 'human',
      reason: 'off topic',
    });

    const result = await runCollectDigression({
      agent: h.agent,
      node: { id: h.node.id },
      activeFlowName: 'raise_work_order',
      run: h.runState,
      driver: h.driver as never,
      ctx: h.ctx,
      select: alwaysRoutes as never,
    });

    // The question is answerable. It must be answered and the flow resumed.
    expect(result.kind).toBe('answeredThenResume');
    expect(h.didSpeak()).toBe(true);
  });

  it('still routes away when the input is NOT a question', async () => {
    const h = await harness('digress-nonquestion', 'transfer me to a human please');

    const alwaysRoutes = async (): Promise<HostSelection> => ({
      kind: 'route',
      agentId: 'human',
      reason: 'explicit request',
    });

    const result = await runCollectDigression({
      agent: h.agent,
      node: { id: h.node.id },
      activeFlowName: 'raise_work_order',
      run: h.runState,
      driver: h.driver as never,
      ctx: h.ctx,
      select: alwaysRoutes as never,
    });

    // Not an off-script question, so the router's verdict stands.
    expect(result.kind).toBe('transition');
  });
});
