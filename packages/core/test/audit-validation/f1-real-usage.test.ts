import { describe, expect, it, mock, afterEach } from 'bun:test';
import type { ModelMessage } from 'ai';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { TokenAccumulator } from '../../src/runtime/TokenAccumulator.js';
import {
  compactMessages,
  estimateMessagesTokens,
} from '../../src/runtime/compaction.js';
import {
  LAST_PROMPT_TOKENS_KEY,
  TOKEN_USAGE_STATE_KEY,
  type PersistedTokenUsage,
} from '../../src/runtime/turnTokenUsage.js';
import { stubModel } from '../core-durable/helpers.js';
import type { ChannelDriver } from '../../src/types/channel.js';

afterEach(() => {
  mock.restore();
});

describe('F1: real token usage budgeting', () => {
  it('TokenAccumulator record() aggregates cumulative totals across turns', () => {
    const acc = new TokenAccumulator();
    acc.record({
      turn: 1,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      latencyMs: 0,
    });
    acc.record({
      turn: 2,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      latencyMs: 0,
    });
    expect(acc.cumulative.totalTokens).toBe(240);
    expect(acc.cumulative.inputTokens).toBe(200);
    expect(acc.cumulative.outputTokens).toBe(40);
  });

  it('persists cumulative usage and last prompt tokens after a stub driver turn', async () => {
    const driver: ChannelDriver = {
      async runAgentTurn() {
        return {
          text: 'Hello.',
          toolResults: [],
          usage: { inputTokens: 500, outputTokens: 50, totalTokens: 550 },
        };
      },
      async awaitUser() {
        return { type: 'message', input: 'hi' };
      },
    };

    const agent = defineAgent({
      id: 'usage-agent',
      instructions: 'You are helpful.',
      model: stubModel,
    });

    const sessionStore = new MemoryStore();
    const sessionId = 'f1-usage-session';
    const runId = sessionId;

    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: 'usage-agent',
      sessionStore,
      defaultModel: stubModel,
    });

    await runtime.run({
      sessionId,
      input: 'hello',
      driver,
    });

    const runStore = new SessionRunStore(sessionStore, sessionId);
    const runState = await runStore.getRunState(runId);
    expect(runState).toBeDefined();

    const tokenUsage = runState!.state[TOKEN_USAGE_STATE_KEY] as PersistedTokenUsage;
    expect(tokenUsage).toEqual({
      inputTokens: 500,
      outputTokens: 50,
      totalTokens: 550,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(runState!.state[LAST_PROMPT_TOKENS_KEY]).toBe(500);
  });

  it('compaction threshold uses real lastPromptTokens when present', async () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'short' },
      { role: 'assistant', content: 'ok' },
    ];
    const estimated = estimateMessagesTokens(messages);

    const under = await compactMessages({
      messages,
      model: stubModel,
      config: { triggerTokens: 10_000 },
      lastPromptTokens: 200,
    });
    expect(under.compacted).toBe(false);
    if (!under.compacted) {
      expect(under.beforeTokens).toBe(200);
      expect(under.beforeTokens).not.toBe(estimated);
    }

    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        generateText: async () => ({ text: 'summary of earlier turns' }),
      };
    });

    const longHistory: ModelMessage[] = [];
    for (let i = 0; i < 10; i += 1) {
      longHistory.push(
        { role: 'user', content: `question ${i} ${'x'.repeat(400)}` },
        { role: 'assistant', content: `answer ${i} ${'y'.repeat(400)}` },
      );
    }

    const over = await compactMessages({
      messages: longHistory,
      model: stubModel,
      config: { triggerTokens: 100, keepRecentMessages: 4 },
      lastPromptTokens: 9_000,
    });
    expect(over.compacted).toBe(true);
    if (over.compacted) {
      expect(over.beforeTokens).toBe(9_000);
    }
  });
});