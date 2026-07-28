import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { action, collect, defineFlow } from '../../src/types/flow.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor, defineTool } from '../../src/tools/effect/index.js';
import { RecoverableToolError } from '../../src/tools/effect/errors.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import type { StreamPart } from '../../src/types/stream.js';

/**
 * When an action node's tool rejects for a business reason, the tool's message is
 * carried to the MODEL as a system note. The USER sees only the collect node's
 * generic `ask()`.
 *
 * Observed live: the tool said "Unit B-12 already has 1 open work order(s):
 * WO-1039 (Dishwasher not draining)" and the manager was asked "which unit is this
 * for, and what exactly is wrong" — no mention of a duplicate, and no way to answer
 * the question that was actually blocking.
 *
 * A `RecoverableToolError` may carry author-written copy for the user. It must reach
 * them verbatim, so the model cannot rephrase a business rule into something else.
 */
describe('recoverable tool error — user-facing reason', () => {
  it('surfaces the error\'s userMessage in the re-ask, verbatim', async () => {
    const USER_COPY = 'B-12 already has WO-1039 open for the dishwasher — same fault, or a separate one?';

    const create = defineTool({
      name: 'create_record',
      description: 'create',
      input: z.object({ unitId: z.string() }),
      execute: async () => {
        throw new RecoverableToolError('Unit B-12 already has 1 open work order(s): WO-1039.', {
          userMessage: USER_COPY,
        });
      },
    });

    const act = action({
      id: 'create',
      run: async (_state, ctx) => {
        await ctx.tool('create_record', { unitId: 'B-12' });
        return { end: 'done' };
      },
    });

    const gather = collect({
      id: 'gather',
      schema: z.object({ unitId: z.string() }),
      required: ['unitId'],
      maxTurns: 3,
      ask: () => 'Which unit is this for?',
      onComplete: () => act,
    });

    const flow = defineFlow({
      name: 'raise',
      description: 'raise a record',
      start: gather,
      nodes: [gather, act],
      maxOscillations: 20,
    });

    const parts: StreamPart[] = [];
    const { session, runStore, runState } = await setupDurableHarness('rec-msg', 'rec-msg-run');
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: { create_record: create } }),
      model: stubModel,
      emit: (part) => parts.push(part),
    });

    const fields = { unitId: 'B-12' };
    const driver = {
      async runAgentTurn() {
        return { text: '', toolResults: [] };
      },
      async runExtraction() {
        return {
          text: '',
          toolResults: [
            { name: 'submit_gather_data', args: fields, result: fields, toolCallId: 'tc' },
          ],
        };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'B-12' };
      },
    };

    ctx.turnInputConsumed = false;
    await runFlow(flow, runState, driver as never, ctx).catch(() => undefined);

    const spoken = parts
      .filter((p) => p.type === 'text-delta')
      .map((p) => String((p as { payload: { delta: string } }).payload.delta))
      .join('');

    // The user must be told why, in the author's words.
    expect(spoken).toContain(USER_COPY);
  });
});
