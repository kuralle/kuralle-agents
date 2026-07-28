import { afterEach, describe, expect, it, mock } from 'bun:test';
import { reply } from '../../src/types/flow.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { defineTool, CoreToolExecutor } from '../../src/tools/effect/index.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { resolveReplyNode } from '../../src/flow/nodeBuilders.js';
import { createEnterFlowTool } from '../../src/tools/enterFlow.js';
import { defineFlow } from '../../src/types/flow.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';

afterEach(() => {
  mock.restore();
});

describe('TextDriver control break', () => {
  it('stops the speaking loop after a control tool sets out.control (exactly one streamText)', async () => {
    let streamCalls = 0;
    const end = reply({ id: 'end', instructions: 'done', next: () => ({ end: 'ok' }) });
    const flow = defineFlow({
      name: 'target-flow',
      description: 'Target',
      start: end,
      nodes: [end],
    });
    const enterFlow = createEnterFlowTool([flow]);

    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: () => {
          streamCalls += 1;
          if (streamCalls === 1) {
            return {
              fullStream: (async function* () {})(),
              finishReason: Promise.resolve('tool-calls'),
              response: Promise.resolve({ messages: [] }),
              toolCalls: Promise.resolve([
                {
                  toolName: 'enter_flow',
                  toolCallId: 'call-enter',
                  input: { flowName: 'target-flow', reason: 'user asked' },
                },
              ]),
              totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
            };
          }
          return {
            fullStream: (async function* () {
              yield Object.assign({ type: 'text-delta' }, { text: 'should not run' });
            })(),
            finishReason: Promise.resolve('stop'),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve([]),
            totalUsage: Promise.resolve({ inputTokens: 100, outputTokens: 10, totalTokens: 110 }),
          };
        },
      };
    });

    const { session, runStore, runState } = await setupDurableHarness('ctrl-break', 'ctrl-break');
    const toolExecutor = new CoreToolExecutor({ tools: { enter_flow: enterFlow } });
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor,
      model: stubModel,
      emit: () => {},
    });

    const node = reply({ id: 'host', instructions: 'Route the user' });
    const resolved = resolveReplyNode(node, {}, { freeConversation: true });
    resolved.hostControl = { dispatchMode: 'strict', advisoryDispatch: false };
    resolved.localTools = { enter_flow: enterFlow };
    Object.assign(resolved.tools ?? {}, { enter_flow: enterFlow });

    const driver = new TextDriver({ toolDefs: { enter_flow: enterFlow } });
    const result = await driver.runAgentTurn(resolved, ctx);

    expect(result.control?.type).toBe('enterFlow');
    expect(streamCalls).toBe(1);
  });
});
