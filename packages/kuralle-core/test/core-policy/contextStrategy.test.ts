import { describe, expect, it } from 'bun:test';
import type { ModelMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { applyContextStrategy } from '../../src/flow/contextStrategy.js';
import { reduceTransition } from '../../src/flow/reduceTransition.js';
import { defineFlow, reply } from '../../src/types/flow.js';
import { setupDurableHarness } from '../core-durable/helpers.js';

function summaryModel(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () =>
      ({
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }) as never,
  });
}

describe('context strategy', () => {
  it('reset keeps system messages and the last user message only', async () => {
    const { runState } = await setupDurableHarness('ctx-reset-sess', 'ctx-reset-run');
    runState.messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
    ] satisfies ModelMessage[];

    await applyContextStrategy({
      strategy: 'reset',
      run: runState,
      flow: defineFlow({
        name: 'f',
        description: 'd',
        start: reply({ id: 'a', instructions: 'x' }),
        nodes: [],
      }),
      model: {} as import('ai').LanguageModel,
    });

    expect(runState.messages).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'second question' },
    ]);
  });

  it('reset_with_summary replaces history with a summary system message', async () => {
    const { runState } = await setupDurableHarness('ctx-sum-sess', 'ctx-sum-run');
    runState.messages = [
      { role: 'user', content: 'We discussed billing for ten minutes.' },
      { role: 'assistant', content: 'Understood.' },
    ] satisfies ModelMessage[];

    const flow = defineFlow({
      name: 'billing',
      description: 'Billing flow',
      start: reply({ id: 'a', instructions: 'x' }),
      nodes: [],
      context: 'reset_with_summary',
    });

    await applyContextStrategy({
      strategy: 'reset_with_summary',
      run: runState,
      flow,
      model: summaryModel('User asked about billing.'),
    });

    expect(runState.messages).toEqual([
      {
        role: 'system',
        content: 'Previous conversation summary: User asked about billing.',
      },
    ]);
  });

  it('reduceTransition applies per-node context strategy on enter', async () => {
    const { runState } = await setupDurableHarness('ctx-node-sess', 'ctx-node-run');
    runState.messages = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'old' },
      { role: 'assistant', content: 'old reply' },
      { role: 'user', content: 'latest' },
    ] satisfies ModelMessage[];

    const target = reply({
      id: 'next',
      instructions: 'Next',
      context: 'reset',
    });
    const flow = defineFlow({
      name: 'f',
      description: 'd',
      start: target,
      nodes: [target],
    });

    await reduceTransition({
      fromNodeId: 'prev',
      toNode: target,
      run: runState,
      flow,
      model: {} as import('ai').LanguageModel,
      emit: () => {},
    });

    expect(runState.messages).toEqual([
      { role: 'system', content: 'System' },
      { role: 'user', content: 'latest' },
    ]);
    expect(runState.activeNode).toBe('next');
  });
});
