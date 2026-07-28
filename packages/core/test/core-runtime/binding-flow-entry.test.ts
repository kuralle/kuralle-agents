import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { collect, defineFlow } from '../../src/types/flow.js';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { hostLoop } from '../../src/runtime/hostLoop.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import type { HostGuardVerdict } from '../../src/runtime/select.js';

/**
 * Flow entry is model-discretionary: `enter_flow` is one tool among many and the
 * model reliably prefers to converse. Measured on an agent whose ONLY tool was
 * `enter_flow` — it still talked for four turns before routing, gathering every
 * field itself and entering the flow only once there was nothing left to collect.
 *
 * The consequence is that a collect node's schema, `required`, `maxTurns` and
 * deterministic `ask` almost never execute. They are presented as enforcement and
 * are not.
 *
 * A flow may declare `binding: true`. When the router says a binding flow owns the
 * request, the runtime enters it directly — the model does not get a turn in which
 * to do the flow's job by hand.
 */
describe('binding flow entry', () => {
  function buildAgent(binding: boolean) {
    const gather = collect({
      id: 'intake',
      schema: z.object({ name: z.string() }),
      required: ['name'],
      ask: () => 'What is your name?',
      onComplete: () => ({ end: 'done' }),
    });
    const flow = defineFlow({
      name: 'intake_flow',
      description: 'Collect intake details',
      start: gather,
      nodes: [gather],
      ...(binding ? { binding: true } : {}),
    });
    return defineAgent({
      id: 'clinic',
      model: stubModel,
      instructions: 'help',
      flows: [flow],
    });
  }

  async function drive(binding: boolean) {
    const { session, runStore, runState } = await setupDurableHarness(
      `bind-${binding}`,
      `bind-${binding}-run`,
    );
    runState.messages = [{ role: 'user', content: 'I need to register' }];
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
    });

    let modelTurns = 0;
    let enteredFlow: string | undefined;
    const driver = {
      async runAgentTurn() {
        modelTurns += 1;
        // The model does what it does live: converse, never call enter_flow.
        return { text: 'Sure, happy to help — what do you need?', toolResults: [] };
      },
      async runExtraction() {
        return { text: '', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: '' };
      },
    };

    // The router knows which flow owns the request.
    const classify = async (): Promise<HostGuardVerdict> => ({
      action: 'enterFlow',
      flowName: 'intake_flow',
      confidence: 1,
    });

    await hostLoop({
      agent: buildAgent(binding),
      run: runState,
      driver: driver as never,
      ctx,
      classify,
    } as never).catch(() => undefined);
    enteredFlow = runState.activeFlow ?? (runState.state.__activeFlow as string | undefined);

    return { modelTurns, entered: enteredFlow };
  }

  it('enters a binding flow without giving the model a turn to bypass it', async () => {
    const r = await drive(true);
    // The whole point: the model never got to converse instead of routing.
    expect(r.modelTurns).toBe(0);
    expect(r.entered).toBe('intake_flow');
  });

  it('leaves a non-binding flow entirely as it is today', async () => {
    const r = await drive(false);
    // Unchanged: the model speaks first and may never route.
    expect(r.modelTurns).toBeGreaterThan(0);
  });
});
