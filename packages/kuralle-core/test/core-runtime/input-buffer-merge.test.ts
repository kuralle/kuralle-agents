import { describe, expect, it } from 'bun:test';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import type { ChannelDriver } from '../../src/types/channel.js';
import { collect } from '../../src/types/flow.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import {
  consumeAllPendingUserInput,
  consumePendingUserInput,
  setPendingUserInput,
} from '../../src/runtime/channels/inputBuffer.js';
import { mergeUserInputContents, userInputToText } from '../../src/runtime/userInput.js';
import { makeTestSession } from '../core-durable/helpers.js';
import { collectUntilComplete } from '../../src/flow/collectUntilComplete.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { sessionDerivedRunId } from '../../src/runtime/openRun.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import { stubModel } from '../core-durable/helpers.js';

describe('consumeAllPendingUserInput', () => {
  it('returns undefined when the queue is empty', () => {
    const session = makeTestSession('empty');
    expect(consumeAllPendingUserInput(session)).toBeUndefined();
  });

  it('returns a single queued item unchanged', () => {
    const session = makeTestSession('single');
    setPendingUserInput(session, 'hello');
    expect(consumeAllPendingUserInput(session)).toBe('hello');
    expect(consumeAllPendingUserInput(session)).toBeUndefined();
  });

  it('merges three queued text items into one parts array', () => {
    const session = makeTestSession('triple');
    setPendingUserInput(session, 'hi');
    setPendingUserInput(session, 'i want to order');
    setPendingUserInput(session, 'the blue one');
    expect(consumeAllPendingUserInput(session)).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'text', text: 'i want to order' },
      { type: 'text', text: 'the blue one' },
    ]);
  });

  it('consumePendingUserInput still dequeues one at a time', () => {
    const session = makeTestSession('fifo');
    setPendingUserInput(session, 'a');
    setPendingUserInput(session, 'b');
    expect(consumePendingUserInput(session)).toBe('a');
    expect(consumePendingUserInput(session)).toBe('b');
  });
});

describe('mergeUserInputContents', () => {
  it('preserves multimodal order across items', () => {
    const merged = mergeUserInputContents([
      [{ type: 'file', data: 'base64', mediaType: 'image/png' }],
      'caption',
    ]);
    expect(merged).toEqual([
      { type: 'file', data: 'base64', mediaType: 'image/png' },
      { type: 'text', text: 'caption' },
    ]);
  });
});

describe('TextDriver awaitUser drain-all', () => {
  it('returns merged pending input for the next turn', async () => {
    const session = makeTestSession('driver-drain');
    setPendingUserInput(session, 'one');
    setPendingUserInput(session, 'two');
    setPendingUserInput(session, 'three');

    const memoryStore = new MemoryStore();
    await memoryStore.save(session);

    const driver = new TextDriver();
    const runState = {
      runId: sessionDerivedRunId(session.id),
      sessionId: session.id,
      status: 'running' as const,
      activeAgentId: 'a',
      state: {},
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const runStore = new SessionRunStore(memoryStore, session.id);
    await runStore.initRun(runState);
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
    });

    const signal = await driver.awaitUser(ctx);
    expect(signal.input).toEqual([
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
      { type: 'text', text: 'three' },
    ]);
    expect(userInputToText(signal.input)).toBe('one two three');
  });
});

describe('collectUntilComplete sees merged pending input', () => {
  it('appends one merged user message when three inputs were queued mid-turn', async () => {
    const nameField = collect({
      id: 'name',
      schema: z.object({ name: z.string() }),
      ask: () => 'What is your name?',
      onComplete: () => ({ end: 'done' }),
    });

    const session = makeTestSession('collect-merge');
    setPendingUserInput(session, 'My');
    setPendingUserInput(session, 'name');
    setPendingUserInput(session, 'is Riley');

    const memoryStore = new MemoryStore();
    await memoryStore.save(session);

    const runState = {
      runId: sessionDerivedRunId(session.id),
      sessionId: session.id,
      status: 'running' as const,
      activeAgentId: 'a',
      activeFlow: 'collect-name',
      state: {},
      messages: [] as ModelMessage[],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const runStore = new SessionRunStore(memoryStore, session.id);
    await runStore.initRun(runState);

    const driver: ChannelDriver = {
      async runAgentTurn() {
        throw new Error('not used');
      },
      async runExtraction() {
        return {
          text: '',
          toolResults: [
            {
              name: 'submit_name_data',
              args: { name: 'Riley' },
              result: { name: 'Riley' },
              toolCallId: 'tc-1',
            },
          ],
        };
      },
      async awaitUser(ctx: import('../../src/types/run-context.js').RunContext) {
        const input = consumeAllPendingUserInput(ctx.session) ?? '';
        return { type: 'message' as const, input };
      },
    };

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      controlModel: stubModel,
      emit: () => {},
    });
    ctx.turnInputConsumed = true;

    const transition = await collectUntilComplete(nameField, runState, driver, ctx);
    expect(transition).toEqual({ kind: 'end', reason: 'done' });
    const userMessages = runState.messages.filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userInputToText(userMessages[0]!.content)).toBe('My name is Riley');
  });
});
