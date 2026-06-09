import { describe, expect, it, mock, afterEach } from 'bun:test';
import type { ModelMessage } from 'ai';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { sessionDerivedRunId } from '../../src/runtime/openRun.js';
import { stubModel } from '../core-durable/helpers.js';
import type { ChannelDriver } from '../../src/types/channel.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';

afterEach(() => {
  mock.restore();
});

function mockSummarizer() {
  mock.module('ai', () => {
    const actual = require('ai');
    return {
      ...actual,
      generateText: async () => ({ text: 'Earlier: user Jane discussed an order.' }),
    };
  });
}

function seedHistory(turns: number, padding = 300): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (let index = 0; index < turns; index += 1) {
    messages.push({ role: 'user', content: `q${index} ${'x'.repeat(padding)}` });
    messages.push({ role: 'assistant', content: `a${index} ${'y'.repeat(padding)}` });
  }
  return messages;
}

async function collectParts(handle: import('../../src/types/stream.js').TurnHandle) {
  const parts: HarnessStreamPart[] = [];
  for await (const part of handle.events) {
    parts.push(part);
  }
  await handle;
  return parts;
}

describe('Runtime compaction wiring', () => {
  it('runs post-turn maintenance compaction when history exceeds the trigger', async () => {
    mockSummarizer();
    const sessionStore = new MemoryStore();
    const driver: ChannelDriver = {
      async runAgentTurn() {
        return { text: 'sure!', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: '' };
      },
    };

    const runtime = createRuntime({
      agents: [defineAgent({ id: 'a', instructions: 'help', model: stubModel })],
      defaultAgentId: 'a',
      sessionStore,
      compaction: { triggerTokens: 500, keepRecentMessages: 4 },
    });

    const handle = runtime.run({
      sessionId: 'compact-sess',
      input: 'hello',
      seedMessages: seedHistory(10),
      driver,
    });
    const parts = await collectParts(handle);

    const compactedEvent = parts.find((part) => part.type === 'context-compacted');
    expect(compactedEvent).toBeDefined();

    const runStore = new SessionRunStore(sessionStore, 'compact-sess');
    const runState = await runStore.getRunState(sessionDerivedRunId('compact-sess'));
    expect(runState?.messages[0]?.role).toBe('system');
    expect(String(runState?.messages[0]?.content)).toContain('Conversation summary');
    // session mirror stays in sync
    const session = await sessionStore.get('compact-sess');
    expect(session?.messages[0]?.role).toBe('system');
  });

  it('recovers from a provider context-overflow with one forced compaction + retry', async () => {
    mockSummarizer();
    const sessionStore = new MemoryStore();
    let calls = 0;
    const driver: ChannelDriver = {
      async runAgentTurn() {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error('maximum context length exceeded'), { statusCode: 400 });
        }
        return { text: 'recovered answer', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message', input: '' };
      },
    };

    const runtime = createRuntime({
      agents: [defineAgent({ id: 'a', instructions: 'help', model: stubModel })],
      defaultAgentId: 'a',
      sessionStore,
      compaction: { triggerTokens: 1_000_000, keepRecentMessages: 4 },
    });

    const handle = runtime.run({
      sessionId: 'overflow-sess',
      input: 'hello',
      seedMessages: seedHistory(10),
      driver,
    });
    const parts = await collectParts(handle);
    const result = await handle;

    expect(calls).toBe(2);
    expect(result.text).toBe('recovered answer');
    const recoveredEvent = parts.find((part) => part.type === 'context-overflow-recovered');
    expect(recoveredEvent).toBeDefined();
    if (recoveredEvent?.type === 'context-overflow-recovered') {
      expect(recoveredEvent.compacted).toBe(true);
    }
    expect(parts.find((part) => part.type === 'context-compacted')).toBeDefined();
  });

  it('does not retry overflow twice (second overflow propagates as error)', async () => {
    mockSummarizer();
    const sessionStore = new MemoryStore();
    let calls = 0;
    const driver: ChannelDriver = {
      async runAgentTurn() {
        calls += 1;
        throw Object.assign(new Error('maximum context length exceeded'), { statusCode: 400 });
      },
      async awaitUser() {
        return { type: 'message', input: '' };
      },
    };

    const runtime = createRuntime({
      agents: [defineAgent({ id: 'a', instructions: 'help', model: stubModel })],
      defaultAgentId: 'a',
      sessionStore,
      compaction: { triggerTokens: 1_000_000, keepRecentMessages: 4 },
    });

    const handle = runtime.run({
      sessionId: 'overflow-sess-2',
      input: 'hello',
      seedMessages: seedHistory(10),
      driver,
    });

    await expect(handle).rejects.toThrow('maximum context length exceeded');
    expect(calls).toBe(2);
  });
});
