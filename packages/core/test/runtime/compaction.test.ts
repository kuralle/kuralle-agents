import { describe, expect, it, mock, afterEach } from 'bun:test';
import type { ModelMessage } from 'ai';
import {
  compactMessages,
  estimateMessagesTokens,
} from '../../src/runtime/compaction.js';
import { addSystemNote, systemNoteBlocks } from '../../src/runtime/systemNotes.js';
import { stubModel } from '../core-durable/helpers.js';
import { setupDurableHarness } from '../core-durable/helpers.js';

afterEach(() => {
  mock.restore();
});

function turn(index: number, padding = 400): ModelMessage[] {
  return [
    { role: 'user', content: `question ${index} ${'x'.repeat(padding)}` },
    { role: 'assistant', content: `answer ${index} ${'y'.repeat(padding)}` },
  ];
}

function mockSummarizer(summary = 'User is Jane; ordered cake #42; prefers delivery to Colombo.') {
  mock.module('ai', () => {
    const actual = require('ai');
    return {
      ...actual,
      generateText: async () => ({ text: summary }),
    };
  });
}

describe('compactMessages', () => {
  it('skips under the trigger threshold', async () => {
    const messages = turn(1);
    const result = await compactMessages({
      messages,
      model: stubModel,
      config: { triggerTokens: 8000 },
    });
    expect(result.compacted).toBe(false);
    if (!result.compacted) {
      expect(result.reason).toBe('under-threshold');
    }
  });

  it('compacts older messages into a leading system summary, keeping the recent tail', async () => {
    mockSummarizer();
    const messages: ModelMessage[] = [];
    for (let index = 0; index < 20; index += 1) {
      messages.push(...turn(index));
    }
    const before = estimateMessagesTokens(messages);

    const result = await compactMessages({
      messages,
      model: stubModel,
      config: { triggerTokens: 100, keepRecentMessages: 6 },
    });

    expect(result.compacted).toBe(true);
    if (!result.compacted) return;
    expect(result.beforeTokens).toBe(before);
    expect(result.afterTokens).toBeLessThan(before);
    expect(result.summarizedCount).toBe(34); // 40 - 6 kept
    expect(result.summary).toContain('[Conversation summary — earlier turns were compacted]');
    expect(result.summary).toContain('User is Jane');
    expect(result.messages.some((message) => message.role === 'system')).toBe(false);
    // kept tail starts at a user message
    expect(result.messages[0]?.role).toBe('user');
    expect(result.messages).toHaveLength(6); // 6 kept, no summary prefix
    // the tail is the verbatim original tail
    expect(result.messages).toEqual(messages.slice(34));
  });

  it('extends the cut backward so the kept slice starts at a user message', async () => {
    mockSummarizer();
    const messages: ModelMessage[] = [];
    for (let index = 0; index < 10; index += 1) {
      messages.push(...turn(index));
    }
    // keepRecentMessages = 5 would start the tail at an assistant message;
    // the cut must walk back to the preceding user message.
    const result = await compactMessages({
      messages,
      model: stubModel,
      config: { triggerTokens: 100, keepRecentMessages: 5 },
    });
    expect(result.compacted).toBe(true);
    if (!result.compacted) return;
    expect(result.messages[0]?.role).toBe('user');
  });

  it('force compacts regardless of threshold', async () => {
    mockSummarizer();
    const messages: ModelMessage[] = [];
    for (let index = 0; index < 10; index += 1) {
      messages.push(...turn(index, 10));
    }
    const result = await compactMessages({
      messages,
      model: stubModel,
      config: { triggerTokens: 1_000_000, keepRecentMessages: 4 },
      force: true,
    });
    expect(result.compacted).toBe(true);
  });

  it('fails closed (no compaction) when the summarizer errors', async () => {
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        generateText: async () => {
          throw new Error('provider down');
        },
      };
    });
    const messages: ModelMessage[] = [];
    for (let index = 0; index < 10; index += 1) {
      messages.push(...turn(index));
    }
    const result = await compactMessages({
      messages,
      model: stubModel,
      config: { triggerTokens: 100 },
    });
    expect(result.compacted).toBe(false);
    if (!result.compacted) {
      expect(result.reason).toBe('summarizer-error');
    }
  });

  it('skips when there is not enough history to fold', async () => {
    mockSummarizer();
    const messages = turn(1, 10_000); // huge single turn — over threshold but nothing to fold
    const result = await compactMessages({
      messages,
      model: stubModel,
      config: { triggerTokens: 100, keepRecentMessages: 12 },
    });
    expect(result.compacted).toBe(false);
    if (!result.compacted) {
      expect(result.reason).toBe('too-few-messages');
    }
  });

  it('chains summaries across two compaction rounds', async () => {
    const capturedPrompts: string[] = [];
    const distinctiveFact = 'BOOKING-REF-XYZ';
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        generateText: async (opts: { prompt?: string }) => {
          capturedPrompts.push(opts.prompt ?? '');
          const input = opts.prompt ?? '';
          if (input.includes(distinctiveFact)) {
            return {
              text: `User Jane; booking ${distinctiveFact}; allergic to peanuts.`,
            };
          }
          return { text: 'User discussed recent order updates.' };
        },
      };
    });

    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: `My booking reference is ${distinctiveFact} and I am allergic to peanuts.`,
      },
      { role: 'assistant', content: 'Noted your booking and allergy.' },
    ];
    for (let index = 0; index < 20; index += 1) {
      messages.push(...turn(index));
    }

    const round1 = await compactMessages({
      messages,
      model: stubModel,
      config: { triggerTokens: 100, keepRecentMessages: 6 },
    });
    expect(round1.compacted).toBe(true);
    if (!round1.compacted) return;
    expect(round1.summary).toContain(distinctiveFact);

    const { runState } = await setupDurableHarness('chain-compact-sess', 'chain-compact-run');
    addSystemNote(runState, round1.summary, { lifetime: 'run', tag: 'compaction-summary' });
    runState.messages = round1.messages;

    const moreTurns: ModelMessage[] = [];
    for (let index = 20; index < 30; index += 1) {
      moreTurns.push(...turn(index));
    }
    runState.messages.push(...moreTurns);

    const { readSystemNote } = await import('../../src/runtime/systemNotes.js');
    const round2 = await compactMessages({
      messages: runState.messages,
      model: stubModel,
      config: { triggerTokens: 100, keepRecentMessages: 6 },
      priorSummary: readSystemNote(runState, 'compaction-summary'),
    });
    expect(round2.compacted).toBe(true);
    if (!round2.compacted) return;

    addSystemNote(runState, round2.summary, { lifetime: 'run', tag: 'compaction-summary' });

    expect(systemNoteBlocks(runState).join('\n')).toContain(distinctiveFact);
    expect(capturedPrompts).toHaveLength(2);
    expect(capturedPrompts[1]).toContain(distinctiveFact);
    expect(capturedPrompts[1]).toContain('Previous conversation summary');
  });
});
