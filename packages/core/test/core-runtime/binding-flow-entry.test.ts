import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { action, collect, defineFlow } from '../../src/types/flow.js';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { hostLoop } from '../../src/runtime/hostLoop.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import type { HostGuardVerdict } from '../../src/runtime/select.js';
import {
  consumeAllPendingUserInput,
  setPendingUserInput,
} from '../../src/runtime/channels/inputBuffer.js';
import { getCollectData } from '../../src/flow/extraction.js';
import type { RunContext } from '../../src/types/run-context.js';
import type { StreamPart } from '../../src/types/stream.js';
import {
  availableHostFlows,
  buildHostControlTools,
} from '../../src/runtime/hostControlTools.js';
import { isValidControl } from '../../src/runtime/hostControlGuard.js';
import { mockV3GenerateObjectModel } from '../helpers/mockLanguageModelV3Results.js';

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

  it('keeps binding flows available to the runtime but not the speaking model', async () => {
    const { runState } = await setupDurableHarness(
      'binding-runtime-only',
      'binding-runtime-only-run',
    );
    const agent = buildAgent(true);

    expect(availableHostFlows(agent, runState).map((flow) => flow.name)).toEqual([
      'intake_flow',
    ]);
    expect(buildHostControlTools(agent, runState)).not.toHaveProperty('enter_flow');
    expect(
      isValidControl({ type: 'enterFlow', flowName: 'intake_flow' }, agent, runState),
    ).toBe(false);
  });

  it('parks on binding entry, then consumes the next turn without cascading', async () => {
    const controlModel = mockV3GenerateObjectModel(async ({ promptText }) => {
      const activeFlowWasAChoice = (promptText ?? '').includes('flow "intake_flow"');
      return {
        object: {
          action: 'enterFlow',
          flowName: activeFlowWasAChoice ? 'intake_flow' : 'unrequested_side_effect',
          agentId: null,
          reason: activeFlowWasAChoice ? 'still answering intake' : 'next-best flow',
          confidence: 0.95,
        },
      };
    });

    let sideEffects = 0;
    const gather = collect({
      id: 'intake',
      schema: z.object({ name: z.string() }),
      required: ['name'],
      ask: () => 'What is your name?',
      onComplete: () => ({ end: 'done' }),
    });
    const intakeFlow = defineFlow({
      name: 'intake_flow',
      description: 'Collect intake details',
      binding: true,
      start: gather,
      nodes: [gather],
      state: { output: (state) => state },
    });
    const unrequestedEffect = action({
      id: 'unrequested_effect',
      run: () => {
        sideEffects += 1;
        return { end: 'effect-fired' };
      },
    });
    const sideEffectFlow = defineFlow({
      name: 'unrequested_side_effect',
      description: 'Perform a separate consequential action',
      start: unrequestedEffect,
      nodes: [unrequestedEffect],
    });
    const agent = defineAgent({
      id: 'clinic',
      model: stubModel,
      instructions: 'help',
      flows: [intakeFlow, sideEffectFlow],
      experimental: { outOfBandControl: true },
    });

    const { session, runStore, runState } = await setupDurableHarness(
      'binding-two-turn',
      'binding-two-turn-run',
    );
    runState.messages = [{ role: 'user', content: 'I need to register' }];

    const parts: StreamPart[] = [];
    let extractionTurns = 0;
    let modelTurns = 0;
    const driver = {
      async runAgentTurn() {
        modelTurns += 1;
        return { text: 'model should not speak', toolResults: [] };
      },
      async runExtraction() {
        extractionTurns += 1;
        if (extractionTurns < 3) {
          return { text: '', toolResults: [] };
        }
        return {
          text: '',
          toolResults: [
            {
              name: 'submit_intake_data',
              args: { name: 'Riley' },
              result: { name: 'Riley' },
            },
          ],
        };
      },
      async awaitUser(ctx: RunContext) {
        return {
          type: 'message' as const,
          input: consumeAllPendingUserInput(ctx.session) ?? '',
        };
      },
    };
    const classify = async (): Promise<HostGuardVerdict> => ({
      action: 'enterFlow',
      flowName: 'intake_flow',
      confidence: 1,
    });

    const firstCtx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      controlModel,
      emit: (part) => parts.push(part),
      outOfBandControl: true,
    });
    const first = await hostLoop({
      agent,
      run: runState,
      driver: driver as never,
      ctx: firstCtx,
      classify,
    });

    expect(first).toEqual({ kind: 'turnComplete' });
    expect(runState.activeFlow).toBe('intake_flow');
    expect(runState.activeNode).toBe('intake');
    expect(sideEffects).toBe(0);
    expect(modelTurns).toBe(0);
    expect(
      parts.some((part) => part.type === 'text-delta' && part.payload.delta === 'What is your name?'),
    ).toBe(true);

    setPendingUserInput(session, 'Riley');
    const secondCtx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      controlModel,
      emit: (part) => parts.push(part),
      outOfBandControl: true,
    });
    const second = await hostLoop({
      agent,
      run: runState,
      driver: driver as never,
      ctx: secondCtx,
      classify,
    });

    expect(second).toEqual({ kind: 'turnComplete' });
    expect(getCollectData(runState.state, gather.id)).toEqual({});
    expect(runState.activeFlow).toBe('intake_flow');
    expect(
      parts.filter(
        (part) => part.type === 'text-delta' && part.payload.delta === 'What is your name?',
      ),
    ).toHaveLength(2);
    expect(sideEffects).toBe(0);
    expect(modelTurns).toBe(0);

    setPendingUserInput(session, 'Riley');
    const thirdCtx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      controlModel,
      emit: (part) => parts.push(part),
      outOfBandControl: true,
    });
    const third = await hostLoop({
      agent,
      run: runState,
      driver: driver as never,
      ctx: thirdCtx,
      classify,
    });

    expect(third).toEqual({ kind: 'turnComplete' });
    expect(getCollectData(runState.state, gather.id)).toEqual({ name: 'Riley' });
    expect(runState.activeFlow).toBeUndefined();
    expect(sideEffects).toBe(0);
    expect(modelTurns).toBe(0);
  });
});
