import { describe, expect, it, mock, afterEach } from 'bun:test';
import type { ModelMessage } from 'ai';
import { z } from 'zod';
import { defineAgent } from '../../src/authoring/defineAgent.js';
import { createRuntime } from '../../src/runtime/Runtime.js';
import { MemoryStore } from '../../src/session/stores/MemoryStore.js';
import { SessionRunStore } from '../../src/runtime/durable/SessionRunStore.js';
import { sessionDerivedRunId } from '../../src/runtime/openRun.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { defineTool, CoreToolExecutor } from '../../src/tools/effect/index.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { resolveReplyNode } from '../../src/flow/nodeBuilders.js';
import { reply } from '../../src/types/flow.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import type { ChannelDriver } from '../../src/types/channel.js';

const secret = 'ZQ-7731-POLICY';

const toolRoundTrip: ModelMessage[] = [
  {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'lookup_policy',
        input: {},
      },
    ],
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'lookup_policy',
        output: { type: 'json', value: { policyCode: secret } },
      },
    ],
  },
];

function hasToolRoleOrCall(messages: ModelMessage[]): boolean {
  return messages.some((m) => {
    if (m.role === 'tool') return true;
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      return m.content.some(
        (part) =>
          typeof part === 'object' &&
          part !== null &&
          'type' in part &&
          (part.type === 'tool-call' || part.type === 'tool-result'),
      );
    }
    return false;
  });
}

afterEach(() => {
  mock.restore();
});

describe('G18: free-conversation tool results in history', () => {
  it('runFreeConversation persists toolMessages before final assistant text', async () => {
    const driver: ChannelDriver = {
      async runAgentTurn() {
        return {
          text: `Your policy code is ${secret}.`,
          toolResults: [
            {
              name: 'lookup_policy',
              args: {},
              result: { policyCode: secret },
              toolCallId: 'call-1',
            },
          ],
          toolMessages: toolRoundTrip,
        };
      },
      async awaitUser() {
        return { type: 'message', input: 'x' };
      },
    };

    const lookup = defineTool({
      name: 'lookup_policy',
      description: 'Look up the policy reference code',
      input: z.object({}),
      execute: async () => ({ policyCode: secret }),
    });

    const agent = defineAgent({
      id: 'ins',
      instructions: 'You are an insurance assistant.',
      model: stubModel,
      globalTools: { lookup_policy: lookup },
    });

    const sessionStore = new MemoryStore();
    const sessionId = 'g18-history';
    const runId = sessionDerivedRunId(sessionId);

    const runtime = createRuntime({
      agents: [agent],
      defaultAgentId: 'ins',
      sessionStore,
      defaultModel: stubModel,
    });

    await runtime.run({
      sessionId,
      input: 'What is my policy reference code?',
      driver,
    });

    const runStore = new SessionRunStore(sessionStore, sessionId);
    const runState = await runStore.getRunState(runId);
    const messages = runState?.messages ?? [];

    expect(hasToolRoleOrCall(messages)).toBe(true);
    expect(messages.some((m) => m.role === 'tool')).toBe(true);
    const assistantIdx = messages.findIndex(
      (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes(secret),
    );
    const toolIdx = messages.findIndex((m) => m.role === 'tool');
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    expect(assistantIdx).toBeGreaterThan(toolIdx);
  });

  it('TextDriver accumulates tool round-trip messages in turn.toolMessages', async () => {
    let streamCall = 0;
    const echoTool = defineTool({
      name: 'lookup_policy',
      description: 'Look up policy',
      input: z.object({}),
      execute: async () => ({ policyCode: secret }),
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
                yield Object.assign({ type: 'text-delta' }, { text: 'Looking up' });
              })(),
              finishReason: Promise.resolve('tool-calls'),
              response: Promise.resolve({
                messages: [
                  {
                    role: 'assistant',
                    content: [
                      {
                        type: 'tool-call',
                        toolCallId: 'call-1',
                        toolName: 'lookup_policy',
                        input: {},
                      },
                    ],
                  },
                ],
              }),
              toolCalls: Promise.resolve([
                { toolName: 'lookup_policy', toolCallId: 'call-1', input: {} },
              ]),
            };
          }
          return {
            fullStream: (async function* () {
              yield Object.assign({ type: 'text-delta' }, { text: `Code is ${secret}` });
            })(),
            finishReason: Promise.resolve('stop'),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve([]),
          };
        },
      };
    });

    const toolExecutor = new CoreToolExecutor({ tools: { lookup_policy: echoTool } });
    const { session, runStore, runState } = await setupDurableHarness('g18-driver', 'g18-driver');

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor,
      model: stubModel,
      emit: () => {},
    });

    const node = reply({ id: 'work', instructions: 'Use lookup_policy' });
    const driver = new TextDriver({ toolDefs: { lookup_policy: echoTool } });
    const result = await driver.runAgentTurn(resolveReplyNode(node, {}, { freeConversation: true }), ctx);

    expect(result.toolMessages).toBeDefined();
    expect(result.toolMessages?.length).toBe(2);
    expect(hasToolRoleOrCall(result.toolMessages ?? [])).toBe(true);
    expect(result.toolResults).toHaveLength(1);
    expect(streamCall).toBe(2);
  });
});