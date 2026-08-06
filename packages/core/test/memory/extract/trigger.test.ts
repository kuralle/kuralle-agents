import { describe, expect, it } from 'bun:test';
import type { ModelMessage } from 'ai';
import {
  DEFAULT_EXTRACTION_TRIGGER,
  detectTurnHadToolCalls,
  resolveExtractionConfig,
  shouldExtract,
} from '../../../src/memory/extract/trigger.js';
import { defineExtractor } from '../../../src/memory/extract/defineExtractor.js';
import { estimateMessagesTokens } from '../../../src/runtime/compaction.js';
import type { RunState } from '../../../src/runtime/durable/types.js';
import { z } from 'zod';

function makeRunState(messages: ModelMessage[], lastExtracted?: number): RunState {
  const now = Date.now();
  return {
    runId: 'run-1',
    sessionId: 'sess-1',
    status: 'running',
    activeAgentId: 'agent-1',
    state: {},
    messages,
    createdAt: now,
    updatedAt: now,
    lastExtractedMessageCount: lastExtracted,
  };
}

describe('shouldExtract token trigger', () => {
  it('does not extract when un-extracted history is below the token threshold', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'sure' },
      { role: 'user', content: 'thanks' },
      { role: 'assistant', content: 'welcome' },
    ];
    const runState = makeRunState(messages);
    expect(shouldExtract(runState, { tokens: 2000 }, false)).toBe(false);
  });

  it('extracts when un-extracted history crosses the token threshold', () => {
    const longContent = 'x'.repeat(8001);
    const messages: ModelMessage[] = [{ role: 'user', content: longContent }];
    const runState = makeRunState(messages);
    expect(estimateMessagesTokens(messages)).toBeGreaterThanOrEqual(2000);
    expect(shouldExtract(runState, { tokens: 2000 }, false)).toBe(true);
  });

  it('measures only messages since the last successful extraction', () => {
    const prior: ModelMessage[] = [{ role: 'user', content: 'y'.repeat(8001) }];
    const recent: ModelMessage[] = [
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'sure' },
    ];
    const runState = makeRunState([...prior, ...recent], prior.length);
    expect(shouldExtract(runState, { tokens: 2000 }, false)).toBe(false);
  });
});

describe('shouldExtract idle trigger', () => {
  it('skips a turn that made tool calls', () => {
    const runState = makeRunState([{ role: 'user', content: 'book it' }]);
    expect(shouldExtract(runState, 'idle', true)).toBe(false);
  });

  it('runs on a conversational turn with no tool calls', () => {
    const runState = makeRunState([{ role: 'user', content: 'my name is Jane' }]);
    expect(shouldExtract(runState, 'idle', false)).toBe(true);
  });
});

describe('shouldExtract each-turn trigger', () => {
  it('runs on every turn regardless of tool calls or history size', () => {
    const runState = makeRunState([{ role: 'user', content: 'ok' }]);
    expect(shouldExtract(runState, 'each-turn', true)).toBe(true);
    expect(shouldExtract(runState, 'each-turn', false)).toBe(true);
  });
});

describe('detectTurnHadToolCalls', () => {
  it('detects assistant tool-call parts and tool-role messages', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'noop', input: {} }],
      },
      { role: 'tool', content: [{ type: 'text', text: 'done' }] },
    ];
    expect(detectTurnHadToolCalls(messages, 0)).toBe(true);
    expect(detectTurnHadToolCalls(messages, 2)).toBe(true);
    expect(detectTurnHadToolCalls(messages, 3)).toBe(false);
  });
});

describe('resolveExtractionConfig', () => {
  it('returns undefined when no extractors are configured', () => {
    expect(resolveExtractionConfig(undefined)).toBeUndefined();
    expect(resolveExtractionConfig({})).toBeUndefined();
  });

  it('defaults trigger to 2000 tokens and blocking to false', () => {
    const extractor = defineExtractor({
      name: 'Color',
      instructions: 'color',
      schema: z.object({ value: z.string() }),
    });
    const config = resolveExtractionConfig({ extract: [extractor] });
    expect(config).toEqual({
      trigger: DEFAULT_EXTRACTION_TRIGGER,
      blocking: false,
    });
  });
});

describe('shouldExtract discriminative guard', () => {
});
