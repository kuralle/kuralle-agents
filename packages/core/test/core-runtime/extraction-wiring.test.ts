import { afterEach, describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { defineExtractor } from '../../src/memory/extract/defineExtractor.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { closeRun } from '../../src/runtime/closeRun.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { InMemoryExtractedValueStore } from '../../src/memory/extract/InMemoryExtractedValueStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { sessionDerivedRunId } from '../../src/runtime/openRun.js';
import { setupDurableHarness, stubModel, buildCtx } from '../core-durable/helpers.js';
import { CoreToolExecutor } from '../../src/tools/effect/index.js';
import type { ChannelDriver } from '../../src/types/channel.js';

afterEach(() => {
  mock.restore();
});

const colorExtractor = defineExtractor({
  name: 'Favorite Color',
  instructions: 'Extract the user favorite color.',
  schema: z.object({ value: z.string() }),
});

function installGenerateObjectMock(
  impl: () => Promise<{ object: Record<string, unknown> }>,
): { calls: { count: number } } {
  const calls = { count: 0 };
  mock.module('ai', () => {
    const actual = require('ai');
    return {
      ...actual,
      generateObject: async () => {
        calls.count += 1;
        return impl();
      },
    };
  });
  return { calls };
}

function conversationalDriver(reply = 'Sure.'): ChannelDriver {
  return {
    async runAgentTurn() {
      return { text: reply, toolResults: [] };
    },
    async awaitUser() {
      return { type: 'message', input: '' };
    },
  };
}

function toolTurnDriver(): ChannelDriver {
  return {
    async runAgentTurn(_node, ctx) {
      ctx.runState.messages.push({
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'lookup',
            input: { q: 'policy' },
          },
        ],
      });
      return { text: 'Looked it up.', toolResults: [] };
    },
    async awaitUser() {
      return { type: 'message', input: '' };
    },
  };
}

async function runTurn(
  runtime: ReturnType<typeof createRuntime>,
  sessionId: string,
  input: string,
  driver: ChannelDriver = conversationalDriver(),
) {
  const handle = runtime.run({ sessionId, input, userId: 'user-1', driver });
  for await (const _part of handle.events) {
    // drain
  }
  await handle;
  await runtime.settled();
}

describe('Runtime extraction wiring', () => {
  it('runs extraction zero times for three short turns and once when history crosses the token threshold', async () => {
    const { calls } = installGenerateObjectMock(async () => ({
      object: { 'favorite-color': { value: 'blue' } },
    }));
    const sessionStore = new MemoryStore();
    const runtime = createRuntime({
      extractedValueStore: new InMemoryExtractedValueStore(),
      agents: [
        defineAgent({
          id: 'a',
          instructions: 'help',
          model: stubModel,
          memory: {
            extract: [colorExtractor],
            extraction: { trigger: { tokens: 2000 } },
          },
        }),
      ],
      defaultAgentId: 'a',
      sessionStore,
    });

    await runTurn(runtime, 'token-sess', 'ok');
    await runTurn(runtime, 'token-sess', 'thanks');
    await runTurn(runtime, 'token-sess', 'bye');
    expect(calls.count).toBe(0);

    await runTurn(runtime, 'token-sess', 'x'.repeat(8001));
    expect(calls.count).toBe(1);
  });

  it("skips extraction on an idle trigger when the turn made tool calls", async () => {
    const { calls } = installGenerateObjectMock(async () => ({
      object: { 'favorite-color': { value: 'blue' } },
    }));
    const sessionStore = new MemoryStore();
    const runtime = createRuntime({
      extractedValueStore: new InMemoryExtractedValueStore(),
      agents: [
        defineAgent({
          id: 'a',
          instructions: 'help',
          model: stubModel,
          memory: {
            extract: [colorExtractor],
            extraction: { trigger: 'idle' },
          },
        }),
      ],
      defaultAgentId: 'a',
      sessionStore,
    });

    await runTurn(runtime, 'idle-sess', 'check policy', toolTurnDriver());
    expect(calls.count).toBe(0);

    await runTurn(runtime, 'idle-sess', 'my favorite color is teal');
    expect(calls.count).toBe(1);
  });

  it('runs extraction on every turn with the each-turn trigger', async () => {
    const { calls } = installGenerateObjectMock(async () => ({
      object: { 'favorite-color': { value: 'blue' } },
    }));
    const sessionStore = new MemoryStore();
    const runtime = createRuntime({
      extractedValueStore: new InMemoryExtractedValueStore(),
      agents: [
        defineAgent({
          id: 'a',
          instructions: 'help',
          model: stubModel,
          memory: {
            extract: [colorExtractor],
            extraction: { trigger: 'each-turn' },
          },
        }),
      ],
      defaultAgentId: 'a',
      sessionStore,
    });

    await runTurn(runtime, 'each-sess', 'one');
    await runTurn(runtime, 'each-sess', 'two');
    expect(calls.count).toBe(2);
  });

  it('resolves closeRun before a non-blocking extraction settles, then settled() waits for it', async () => {
    let resolveExtraction!: () => void;
    const extractionGate = new Promise<void>((resolve) => {
      resolveExtraction = resolve;
    });
    let extractionEntered = false;
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        generateObject: async () => {
          extractionEntered = true;
          await extractionGate;
          return { object: { 'favorite-color': { value: 'blue' } } };
        },
      };
    });

    const sessionStore = new MemoryStore();
    const runtime = createRuntime({
      extractedValueStore: new InMemoryExtractedValueStore(),
      agents: [
        defineAgent({
          id: 'a',
          instructions: 'help',
          model: stubModel,
          memory: {
            extract: [colorExtractor],
            extraction: { trigger: 'each-turn', blocking: false },
          },
        }),
      ],
      defaultAgentId: 'a',
      sessionStore,
    });

    const handle = runtime.run({
      sessionId: 'defer-sess',
      input: 'hello',
      userId: 'user-1',
      driver: conversationalDriver(),
    });

    let sawDone = false;
    for await (const part of handle.events) {
      if (part.type === 'done') {
        sawDone = true;
        break;
      }
    }
    expect(sawDone).toBe(true);
    expect(extractionEntered).toBe(true);

    const settledRace = await Promise.race([
      runtime.settled().then(() => 'settled' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
    ]);
    expect(settledRace).toBe('pending');

    resolveExtraction();
    await handle;
    await runtime.settled();
  });

  it('does not surface an unhandled rejection when a non-blocking extraction rejects', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      mock.module('ai', () => {
        const actual = require('ai');
        return {
          ...actual,
          generateObject: async () => {
            throw new Error('extraction model unavailable');
          },
        };
      });

      const sessionStore = new MemoryStore();
      const runtime = createRuntime({
      extractedValueStore: new InMemoryExtractedValueStore(),
        agents: [
          defineAgent({
            id: 'a',
            instructions: 'help',
            model: stubModel,
            memory: {
              extract: [colorExtractor],
              extraction: { trigger: 'each-turn', blocking: false },
            },
          }),
        ],
        defaultAgentId: 'a',
        sessionStore,
      });

      await runTurn(runtime, 'reject-sess', 'hello');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does not advance lastExtractedMessageCount on failure so the next turn retries', async () => {
    let attempt = 0;
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        generateObject: async () => {
          attempt += 1;
          if (attempt === 1) {
            throw new Error('temporary extraction failure');
          }
          return { object: { 'favorite-color': { value: 'blue' } } };
        },
      };
    });

    const sessionStore = new MemoryStore();
    const runtime = createRuntime({
      extractedValueStore: new InMemoryExtractedValueStore(),
      agents: [
        defineAgent({
          id: 'a',
          instructions: 'help',
          model: stubModel,
          memory: {
            extract: [colorExtractor],
            extraction: { trigger: { tokens: 2000 } },
          },
        }),
      ],
      defaultAgentId: 'a',
      sessionStore,
    });

    const longInput = 'x'.repeat(8001);
    await runTurn(runtime, 'retry-sess', longInput);
    const runStore = new SessionRunStore(sessionStore, 'retry-sess');
    let runState = await runStore.getRunState(sessionDerivedRunId('retry-sess'));
    expect(runState?.lastExtractedMessageCount).toBeUndefined();

    await runTurn(runtime, 'retry-sess', 'ok');
    runState = await runStore.getRunState(sessionDerivedRunId('retry-sess'));
    expect(runState?.lastExtractedMessageCount).toBe(runState?.messages.length);
    expect(attempt).toBe(2);
  });
});

describe('closeRun extraction ordering', () => {
  it('resolves closeRun before a non-blocking extraction settles', async () => {
    const { session, memoryStore, runStore, runState } = await setupDurableHarness(
      'close-sess',
      'close-run',
    );
    session.userId = 'user-1';
    runState.messages = [{ role: 'user', content: 'hello' }];

    let resolveExtraction!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveExtraction = resolve;
    });
    let extractionFinished = false;

    const ctx = await buildCtx({
      session,
      runStore,
      runState,
      toolExecutor: new CoreToolExecutor({ tools: {} }),
    });

    const pendingExtractions = new Set<Promise<void>>();
    const trackBackground = (promise: Promise<void>) => {
      const pending = promise.finally(() => pendingExtractions.delete(pending));
      pendingExtractions.add(pending);
    };

    const closePromise = closeRun({
      session,
      runState: ctx.runState,
      runStore,
      sessionStore: memoryStore,
      ctx,
      extraction: {
        config: { trigger: 'each-turn', blocking: false },
        turnMessageBaseline: 0,
        trackBackground,
        run: async () => {
          await gate;
          extractionFinished = true;
          return true;
        },
      },
    });

    const closedEarly = await Promise.race([
      closePromise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30)),
    ]);
    expect(closedEarly).toBe(true);
    expect(extractionFinished).toBe(false);

    resolveExtraction();
    await closePromise;
    await Promise.allSettled([...pendingExtractions]);
    expect(extractionFinished).toBe(true);
  });
});
