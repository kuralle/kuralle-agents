import { describe, expect, it, mock, afterEach } from 'bun:test';
import { decide, reply } from '../../src/types/flow.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { defineTool, CoreToolExecutor } from '../../src/tools/effect/index.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { resolveReplyNode } from '../../src/flow/nodeBuilders.js';
import { createEventBus, createTurnHandle } from '../../src/events/TurnHandle.js';
import {
  setupDurableHarness,
  stubModel,
} from '../core-durable/helpers.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';
import type { ValidationCapability } from '../../src/capabilities/ValidationCapability.js';
import { z } from 'zod';

const TEXT_LIFECYCLE = new Set(['text-start', 'text-delta', 'text-end', 'text-cancel']);

function mockMultiChunkStream(chunks: string[]) {
  mock.module('ai', () => {
    const actual = require('ai');
    return {
      ...actual,
      streamText: () => ({
        fullStream: (async function* () {
          for (const text of chunks) {
            yield Object.assign({ type: 'text-delta' }, { text });
          }
        })(),
        finishReason: Promise.resolve('stop'),
        response: Promise.resolve({ messages: [] }),
        toolCalls: Promise.resolve([]),
      }),
    };
  });
}

afterEach(() => {
  mock.restore();
});

describe('TextDriver unit', () => {
  it('streams text-delta events and returns TurnResult', async () => {
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: () => ({
          fullStream: (async function* () {
            yield Object.assign({ type: 'text-delta' }, { text: 'Hello' });
            yield Object.assign({ type: 'text-delta' }, { text: ' world' });
          })(),
          finishReason: Promise.resolve('stop'),
          response: Promise.resolve({ messages: [] }),
          toolCalls: Promise.resolve([]),
        }),
      };
    });

    const { session, runStore, runState } = await setupDurableHarness();
    const parts: HarnessStreamPart[] = [];
    const toolExecutor = new CoreToolExecutor({ tools: {} });

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor,
      model: stubModel,
      emit: (p) => parts.push(p),
    });

    const node = reply({ id: 'greet', instructions: 'Say hello' });
    const driver = new TextDriver();
    const result = await driver.runAgentTurn(resolveReplyNode(node, {}), ctx);

    expect(result.text).toBe('Hello world');
    expect(parts.filter((p) => p.type === 'text-delta').map((p) => p.delta).join('')).toBe('Hello world');
    expect(parts.some((p) => p.type === 'turn-end')).toBe(true);
  });

  it('routes tool calls through ctx.tool and records StepRecord', async () => {
    let streamCall = 0;
    let executeCount = 0;
    const echoTool = defineTool({
      name: 'echo',
      description: 'Echo args',
      input: z.object({ value: z.string() }),
      execute: async (args) => {
        executeCount += 1;
        return args;
      },
    });

    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: () => {
          streamCall += 1;
          if (streamCall === 1) {
            return {
              fullStream: (async function* () {
                yield Object.assign({ type: 'text-delta' }, { text: 'Calling tool' });
              })(),
              finishReason: Promise.resolve('tool-calls'),
              response: Promise.resolve({
                messages: [
                  {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'Calling tool' }],
                  },
                ],
              }),
              toolCalls: Promise.resolve([
                { toolName: 'echo', toolCallId: 'call-1', input: { value: 'test' } },
              ]),
            };
          }
          return {
            fullStream: (async function* () {
              yield Object.assign({ type: 'text-delta' }, { text: ' Done' });
            })(),
            finishReason: Promise.resolve('stop'),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve([]),
          };
        },
      };
    });

    const toolExecutor = new CoreToolExecutor({ tools: { echo: echoTool } });
    const { session, runStore, runState } = await setupDurableHarness();

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor,
      model: stubModel,
      emit: () => {},
    });

    const node = reply({ id: 'work', instructions: 'Use echo tool' });
    const driver = new TextDriver({ toolDefs: { echo: echoTool } });
    const result = await driver.runAgentTurn(resolveReplyNode(node, {}), ctx);

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]?.result).toEqual({ value: 'test' });
    expect(executeCount).toBe(1);
    expect(streamCall).toBe(2);

    const steps = await runStore.getSteps(runState.runId);
    expect(steps.some((s) => s.kind === 'tool' && s.name === 'echo')).toBe(true);
  });

  it('TurnHandle awaits result, iterates events, and exposes toResponseStream', async () => {
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: () => ({
          fullStream: (async function* () {
            yield Object.assign({ type: 'text-delta' }, { text: 'Hi' });
          })(),
          finishReason: Promise.resolve('stop'),
          response: Promise.resolve({ messages: [] }),
          toolCalls: Promise.resolve([]),
        }),
      };
    });

    const bus = createEventBus();
    const { session, runStore, runState } = await setupDurableHarness();
    const toolExecutor = new CoreToolExecutor({ tools: {} });

    const handle = createTurnHandle({
      bus,
      run: async () => {
        const ctx = await createRunContext({
          session,
          runState,
          runStore,
          steps: [],
          toolExecutor,
          model: stubModel,
          emit: (p) => bus.emit(p),
        });
        const driver = new TextDriver();
        return driver.runAgentTurn(
          resolveReplyNode(reply({ id: 'r', instructions: 'Hi' }), {}),
          ctx,
        );
      },
    });

    const collected: HarnessStreamPart[] = [];
    for await (const part of handle.events) {
      collected.push(part);
    }

    const turn = await handle;
    expect(turn.text).toBe('Hi');
    expect(collected.some((p) => p.type === 'text-delta')).toBe(true);
    expect(typeof handle.toResponseStream).toBe('function');
    expect(typeof handle.cancel).toBe('function');
  });

  describe('S1-03 speakGated streaming', () => {
    it('REQ-1: ungated reply streams >1 text-delta with first before turn-end', async () => {
      const chunks = ['Hello', ' world', '. How', ' are you?'];
      mockMultiChunkStream(chunks);

      const parts: HarnessStreamPart[] = [];
      const { session, runStore, runState } = await setupDurableHarness();
      const ctx = await createRunContext({
        session,
        runState,
        runStore,
        steps: [],
        toolExecutor: new CoreToolExecutor({ tools: {} }),
        model: stubModel,
        emit: (p) => parts.push(p),
      });

      const node = reply({ id: 'stream', instructions: 'Say hello' });
      const result = await new TextDriver().runAgentTurn(resolveReplyNode(node, {}), ctx);

      expect(result.text).toBe(chunks.join(''));
      const deltas = parts.filter((p) => p.type === 'text-delta');
      expect(deltas.length).toBeGreaterThan(1);
      const firstDeltaIdx = parts.findIndex((p) => p.type === 'text-delta');
      const turnEndIdx = parts.findIndex((p) => p.type === 'turn-end');
      expect(firstDeltaIdx).toBeGreaterThanOrEqual(0);
      expect(turnEndIdx).toBeGreaterThan(firstDeltaIdx);
      expect(parts.some((p) => p.type === 'text-start')).toBe(true);
      expect(parts.some((p) => p.type === 'text-end')).toBe(true);
    });

    it('REQ-3: turn-mode node buffers to one lifecycle message', async () => {
      const chunks = ['First ', 'second ', 'third'];
      mockMultiChunkStream(chunks);

      const turnPolicy: ValidationCapability = {
        name: 'turn-buffer',
        validate: async () => ({ decision: 'continue', confidence: 1 }),
      };

      const parts: HarnessStreamPart[] = [];
      const { session, runStore, runState } = await setupDurableHarness();
      const ctx = await createRunContext({
        session,
        runState,
        runStore,
        steps: [],
        toolExecutor: new CoreToolExecutor({ tools: {} }),
        model: stubModel,
        validationPolicies: [turnPolicy],
        emit: (p) => parts.push(p),
      });

      const node = reply({ id: 'grounded', instructions: 'Answer' });
      const result = await new TextDriver().runAgentTurn(resolveReplyNode(node, {}), ctx);

      expect(result.text).toBe(chunks.join(''));
      expect(parts.filter((p) => p.type === 'text-delta')).toHaveLength(1);
      expect(parts.filter((p) => p.type === 'text-start')).toHaveLength(1);
      expect(parts.filter((p) => p.type === 'text-end')).toHaveLength(1);
    });

    it('REQ-3: turn-mode block never emits model partials', async () => {
      const leaked = 'LEAKED-SECRET';
      mockMultiChunkStream([leaked.slice(0, 6), leaked.slice(6)]);

      const blockPolicy: ValidationCapability = {
        name: 'block-all',
        async validate() {
          return {
            decision: 'block',
            confidence: 0,
            rationale: 'blocked',
            userFacingMessage: 'safe only',
          };
        },
      };

      const parts: HarnessStreamPart[] = [];
      const { session, runStore, runState } = await setupDurableHarness();
      const ctx = await createRunContext({
        session,
        runState,
        runStore,
        steps: [],
        toolExecutor: new CoreToolExecutor({ tools: {} }),
        model: stubModel,
        validationPolicies: [blockPolicy],
        emit: (p) => parts.push(p),
      });

      const node = reply({ id: 'blocked', instructions: 'Answer' });
      const result = await new TextDriver().runAgentTurn(resolveReplyNode(node, {}), ctx);

      expect(result.text).toBe('safe only');
      const streamText = parts
        .filter((p) => p.type === 'text-delta')
        .map((p) => (p as { delta: string }).delta)
        .join('');
      expect(streamText).not.toContain('LEAKED');
      expect(streamText).toBe('safe only');
    });

    it('REQ-12: runExtraction emits zero text lifecycle events', async () => {
      mock.module('ai', () => {
        const actual = require('ai');
        return {
          ...actual,
          streamText: () => ({
            fullStream: (async function* () {
              yield Object.assign({ type: 'text-delta' }, { text: 'would speak' });
            })(),
            finishReason: Promise.resolve('stop'),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve([]),
          }),
        };
      });

      const parts: HarnessStreamPart[] = [];
      const { session, runStore, runState } = await setupDurableHarness();
      const ctx = await createRunContext({
        session,
        runState,
        runStore,
        steps: [],
        toolExecutor: new CoreToolExecutor({ tools: {} }),
        model: stubModel,
        emit: (p) => parts.push(p),
      });

      const node = reply({ id: 'extract', instructions: 'Extract only' });
      await new TextDriver().runExtraction(resolveReplyNode(node, {}), ctx);

      expect(parts.filter((p) => TEXT_LIFECYCLE.has(p.type))).toHaveLength(0);
    });
  });

  it('runStructured uses a closed enum schema for choice-decides', async () => {
    let capturedSchema: unknown;
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        generateObject: async ({ schema }: { schema: unknown }) => {
          capturedSchema = schema;
          return { object: { choice: 'checkout' } };
        },
      };
    });

    const { session, runStore, runState } = await setupDurableHarness();
    runState.messages = [{ role: 'user', content: 'something unrelated entirely' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
    });

    const node = decide({
      id: 'cart',
      instructions: 'Review the cart',
      schema: z.object({ choice: z.string() }),
      decide: () => 'stay',
    });
    node.choices = [
      { id: 'checkout', label: 'Checkout' },
      { id: 'more', label: 'Add another gift' },
    ];

    await new TextDriver().runStructured(node, ctx);

    const { isConstrainedChoiceEnumSchema } = await import('../../src/flow/choiceMatch.js');
    expect(isConstrainedChoiceEnumSchema(capturedSchema)).toBe(true);
    const parsed = (capturedSchema as import('zod').ZodObject<{ choice: import('zod').ZodEnum<[string, ...string[]]> }>).safeParse({
      choice: 'bogus',
    });
    expect(parsed.success).toBe(false);
  });
});
