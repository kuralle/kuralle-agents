import { describe, expect, it, mock, afterEach } from 'bun:test';
import type { ModelMessage } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { compactMessages } from '../../src/runtime/compaction.js';
import { applyContextStrategy } from '../../src/flow/contextStrategy.js';
import { AiSdkModelTurnLoop } from '../../src/runtime/channels/AiSdkModelTurnLoop.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import {
  assertNoSystemRoleInModelMessages,
  hasSystemRoleInModelMessages,
} from '../../src/runtime/modelMessagesGuard.js';
import { defineFlow, reply } from '../../src/types/flow.js';
import { setupDurableHarness } from '../core-durable/helpers.js';
import { stubModel } from '../core-durable/helpers.js';

afterEach(() => {
  mock.restore();
});

function mockSummarizer(summary = 'User is Jane; ordered cake #42.') {
  mock.module('ai', () => {
    const actual = require('ai');
    return {
      ...actual,
      generateText: async () => ({ text: summary }),
    };
  });
}

function turn(index: number, padding = 400): ModelMessage[] {
  return [
    { role: 'user', content: `question ${index} ${'x'.repeat(padding)}` },
    { role: 'assistant', content: `answer ${index} ${'y'.repeat(padding)}` },
  ];
}

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

describe('no system role in model message array', () => {
  it('compactMessages never returns role system in messages', async () => {
    mockSummarizer();
    const messages: ModelMessage[] = [];
    for (let index = 0; index < 20; index += 1) {
      messages.push(...turn(index));
    }

    const result = await compactMessages({
      messages,
      model: stubModel,
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
      model: summaryModel('User asked about billing.'),
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
      model: {} as import('ai').LanguageModel,
    });

    expect(hasSystemRoleInModelMessages(runState.messages)).toBe(false);
    assertNoSystemRoleInModelMessages(runState.messages, 'reset');
    expect(runState.messages).toEqual([{ role: 'user', content: 'second question' }]);
  });

});
