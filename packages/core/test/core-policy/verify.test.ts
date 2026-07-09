import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { action, defineFlow, reply } from '../../src/types/flow.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { setupDurableHarness } from '../core-durable/helpers.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';

describe('flow verify contract', () => {
  it('blocks transition when outputSchema check fails against real state', async () => {
    const next = reply({ id: 'next', instructions: 'Should not reach', next: () => ({ end: 'done' }) });
    const gate = action({
      id: 'gate',
      outputSchema: z.object({ charged: z.literal(true) }),
      run: async () => next,
    });
    const flow = defineFlow({
      name: 'verify-flow',
      description: 'Verify gate',
      start: gate,
      nodes: [gate, next],
    });

    const driver = {
      async runAgentTurn() {
        return { text: 'nope', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'x' };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness('verify-fail', 'verify-fail-run');
    const errors: HarnessStreamPart[] = [];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: {} as import('ai').LanguageModel,
      emit: (part) => errors.push(part),
    });

    const result = await runFlow(flow, runState, driver, ctx);
    expect(result).toEqual({ kind: 'awaitingUser' });
    expect(errors.some((part) => part.type === 'error' && part.error.includes('Verify blocked'))).toBe(true);
    expect(runState.activeNode).toBe('gate');
  });

  it('passes transition when state satisfies outputSchema', async () => {
    const next = reply({ id: 'next', instructions: 'Done', next: () => ({ end: 'done' }) });
    const gate = action({
      id: 'gate',
      verify: {
        check: ({ state }) => state.charged === true,
      },
      run: async (state, ctx) => {
        await ctx.tool('mark', {});
        state.charged = true;
        return next;
      },
    });
    const flow = defineFlow({
      name: 'verify-pass',
      description: 'Verify pass',
      start: gate,
      nodes: [gate, next],
    });

    const markSpy = { count: 0 };
    const toolExecutor = {
      execute: async ({ name }: { name: string }) => {
        if (name === 'mark') {
          markSpy.count += 1;
        }
        return { ok: true };
      },
    };

    const driver = {
      async runAgentTurn() {
        return { text: 'ok', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'x' };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness('verify-pass', 'verify-pass-run');
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor,
      model: {} as import('ai').LanguageModel,
      emit: () => {},
    });

    const result = await runFlow(flow, runState, driver, ctx);
    expect(result).toEqual({ kind: 'ended', reason: 'done' });
    expect(markSpy.count).toBe(1);
  });
});
