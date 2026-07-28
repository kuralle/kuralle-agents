import { systemNoteBlocks } from '../../src/runtime/systemNotes.js';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { action, collect, defineFlow } from '../../src/types/flow.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor, defineTool } from '../../src/tools/effect/index.js';
import { RecoverableToolError } from '../../src/tools/effect/errors.js';
import { isControlFlowSignal, isRecoverableToolError } from '../../src/runtime/controlFlowSignal.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import { SuspendError } from '../../src/runtime/durable/RunStore.js';
import type { StreamPart } from '../../src/types/stream.js';

describe('recoverable tool error inside a flow', () => {
  it('a recoverable action error re-asks instead of ending the flow', async () => {
    // The tool is the boundary that knows "12B" is not a real unit — exactly the case that
    // produced a dead-end degrade before this fix.
    const createWorkOrder = defineTool({
      name: 'create_work_order',
      description: 'create',
      input: z.object({ unitId: z.string() }),
      execute: async (args) => {
        throw new RecoverableToolError(
          `Unknown unit '${args.unitId}'. Call list_units to get a real unit id — do not invent one.`,
        );
      },
    });

    const create = action({
      id: 'create',
      run: async (_state, ctx) => {
        // The action calls the tool imperatively (no model tool-call to attach a result to).
        await ctx.tool('create_work_order', { unitId: '12B' });
        return { end: 'done' };
      },
    });
    const gather = collect({
      id: 'gather',
      schema: z.object({ unitId: z.string() }),
      ask: () => 'Which unit is the work order for?',
      onComplete: () => create,
    });
    const flow = defineFlow({
      name: 'raise_work_order',
      description: 'Raise a work order',
      start: gather,
      nodes: [gather, create],
    });

    const driver = {
      async runAgentTurn() {
        return { text: '', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'continue' };
      },
    };

    const parts: StreamPart[] = [];
    const { session, runStore, runState } = await setupDurableHarness('rec-sess', 'rec-run');
    // Simulate that the gather node already collected "12B" this turn and handed off to the
    // action. Set activeNode/activeFlow so runFlow skips the fresh-entry cache clear
    // (clearFlowCollectCache) that would otherwise wipe this before the action runs.
    runState.activeFlow = 'raise_work_order';
    runState.activeNode = 'gather';
    runState.flowFrame = {
      flow: 'raise_work_order',
      state: { __collect_gather: { unitId: '12B' } },
    };
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: { create_work_order: createWorkOrder } }),
      model: stubModel,
      emit: (part) => parts.push(part),
    });
    ctx.turnInputConsumed = true;

    const result = await runFlow(flow, runState, driver, ctx);

    // The discriminative assertion: a recoverable error RE-ASKS, it does not end.
    expect(result).toEqual({ kind: 'awaitingUser' });
    expect(runState.activeNode).toBe('gather');
    // The gather cache was cleared so re-collection actually happens (not an instant
    // re-complete with the bad value).
    expect(runState.flowFrame?.state.__collect_gather).toBeUndefined();
    // The error reaches the model through the system-note channel, NOT the message array —
    // it interpolates tool output containing user-supplied ids, so it must not sit where it
    // could read as an instruction (AI SDK 7 rejects system messages in `messages`).
    expect(systemNoteBlocks(runState).join('\n')).toContain("Unknown unit '12B'");
    expect(
      runState.messages.some((m) => m.role === 'system'),
    ).toBe(false);
    // The user saw a re-ask, not the degraded apology.
    expect(parts.some((p) => p.type === 'text-delta' && /Which unit/.test(p.payload.delta))).toBe(true);
    expect(parts.some((p) => p.type === 'text-delta' && p.payload.delta.includes('something went wrong'))).toBe(false);
  });

  it('a recoverable error with no prior collect node degrades (nowhere to re-collect)', async () => {
    // The action is the start node: no collect fed it, so there is nowhere to return to.
    const boom = action({
      id: 'boom',
      run: async () => {
        throw new RecoverableToolError('nothing to re-collect from');
      },
    });
    const flow = defineFlow({ name: 'no-collect', description: 'x', start: boom, nodes: [boom] });

    const driver = {
      async runAgentTurn() {
        return { text: '', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'x' };
      },
    };
    const { session, runStore, runState } = await setupDurableHarness('rec-nocollect-sess', 'rec-nocollect-run');
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
    });

    const result = await runFlow(flow, runState, driver, ctx);
    expect(result.kind).toBe('ended');
  });

  it('a SuspendError still propagates untouched through the recoverable branch', async () => {
    // Highest regression risk (REQ-A4): approval/signal waits must keep working. A recoverable
    // check that runs before the suspend rethrow would swallow the suspend.
    const suspendingTool = defineTool({
      name: 'needs_human',
      description: 'x',
      input: z.object({}),
      needsApproval: true,
      execute: async () => 'ok',
    });
    const create = action({
      id: 'create',
      run: async (_state, ctx) => {
        await ctx.tool('needs_human', {});
        return { end: 'done' };
      },
    });
    const gather = collect({
      id: 'gather',
      schema: z.object({ x: z.string() }),
      onComplete: () => create,
    });
    const flow = defineFlow({ name: 'approve-flow', description: 'x', start: gather, nodes: [gather, create] });

    const driver = {
      async runAgentTurn() {
        return { text: '', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'x' };
      },
    };
    const { session, runStore, runState } = await setupDurableHarness('rec-suspend-sess', 'rec-suspend-run');
    runState.activeFlow = 'approve-flow';
    runState.activeNode = 'gather';
    runState.flowFrame = {
      flow: 'approve-flow',
      state: { __collect_gather: { x: '1' } },
    };
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: { needs_human: suspendingTool } }),
      model: stubModel,
      emit: () => {},
    });
    ctx.turnInputConsumed = true;

    await expect(runFlow(flow, runState, driver, ctx)).rejects.toBeInstanceOf(SuspendError);
    const paused = (await runStore.getRunState(runState.runId))!;
    expect(paused.status).toBe('paused');
    expect(paused.waitingFor?.signalName).toBe('__approval');
  });

  it('isRecoverableToolError classifies by type, not message', () => {
    expect(isRecoverableToolError(new RecoverableToolError('x'))).toBe(true);
    expect(isRecoverableToolError(new Error('recoverable-sounding message'))).toBe(false);
    // A SuspendError is NOT recoverable — it is a control-flow signal.
    expect(isRecoverableToolError(new SuspendError('__approval'))).toBe(false);
    expect(isControlFlowSignal(new RecoverableToolError('x'))).toBe(false);
  });
});
