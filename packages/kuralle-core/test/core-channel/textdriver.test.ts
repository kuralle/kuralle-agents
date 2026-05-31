import { describe, expect, it, mock, afterEach } from 'bun:test';
import { reply } from '../../src/types/flow.js';
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
import { z } from 'zod';

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
            yield { type: 'text-delta', text: 'Hello' };
            yield { type: 'text-delta', text: ' world' };
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
    expect(parts.filter((p) => p.type === 'text-delta').map((p) => (p as { text: string }).text).join('')).toBe('Hello world');
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
                yield { type: 'text-delta', text: 'Calling tool' };
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
              yield { type: 'text-delta', text: ' Done' };
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
            yield { type: 'text-delta', text: 'Hi' };
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
});
