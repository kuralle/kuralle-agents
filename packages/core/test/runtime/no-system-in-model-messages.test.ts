import { describe, expect, it } from 'bun:test';
import type { LanguageModel, ModelMessage } from 'ai';
import { compactMessages } from '../../src/runtime/compaction.js';
import { applyContextStrategy } from '../../src/flow/contextStrategy.js';
import {
  assertNoSystemRoleInModelMessages,
  hasSystemRoleInModelMessages,
} from '../../src/runtime/modelMessagesGuard.js';
import { defineFlow, reply } from '../../src/types/flow.js';
import { setupDurableHarness } from '../core-durable/helpers.js';
import { mockV3SummarizerModel } from '../helpers/mockLanguageModelV3Results.js';

function turn(index: number, padding = 400): ModelMessage[] {
  return [
    { role: 'user', content: `question ${index} ${'x'.repeat(padding)}` },
    { role: 'assistant', content: `answer ${index} ${'y'.repeat(padding)}` },
  ];
}

describe('no system role in model message array', () => {
  it('compactMessages never returns role system in messages', async () => {
    const model = mockV3SummarizerModel('User is Jane; ordered cake #42.');
    const messages: ModelMessage[] = [];
    for (let index = 0; index < 20; index += 1) {
      messages.push(...turn(index));
    }

    const result = await compactMessages({
      messages,
      model,
      config: { triggerTokens: 100, keepRecentMessages: 6 },
    });

    expect(result.compacted).toBe(true);
    if (!result.compacted) return;
    expect(hasSystemRoleInModelMessages(result.messages)).toBe(false);
    assertNoSystemRoleInModelMessages(result.messages, 'compactMessages');
  });

  it('applyContextStrategy reset_with_summary never leaves role system in run.messages', async () => {
    const { runState } = await setupDurableHarness('no-sys-sum', 'no-sys-sum-run');
    runState.messages = [
      { role: 'user', content: 'We discussed billing for ten minutes.' },
      { role: 'assistant', content: 'Understood.' },
    ] satisfies ModelMessage[];

    const start = reply({ id: 'a', instructions: 'x' });
    await applyContextStrategy({
      strategy: 'reset_with_summary',
      run: runState,
      flow: defineFlow({
        name: 'billing',
        description: 'Billing flow',
        start,
        nodes: [start],
        context: 'reset_with_summary',
      }),
      model: mockV3SummarizerModel('User asked about billing.'),
    });

    expect(hasSystemRoleInModelMessages(runState.messages)).toBe(false);
    assertNoSystemRoleInModelMessages(runState.messages, 'reset_with_summary');
  });

  it('applyContextStrategy reset drops system entries from run.messages', async () => {
    const { runState } = await setupDurableHarness('no-sys-reset', 'no-sys-reset-run');
    runState.messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
    ] satisfies ModelMessage[];

    const start = reply({ id: 'a', instructions: 'x' });
    await applyContextStrategy({
      strategy: 'reset',
      run: runState,
      flow: defineFlow({
        name: 'f',
        description: 'd',
        start,
        nodes: [start],
      }),
      model: {} as LanguageModel,
    });

    expect(hasSystemRoleInModelMessages(runState.messages)).toBe(false);
    assertNoSystemRoleInModelMessages(runState.messages, 'reset');
    expect(runState.messages).toEqual([{ role: 'user', content: 'second question' }]);
  });

});
