import { describe, expect, it, mock, afterEach } from 'bun:test';
import { z } from 'zod';
import { action, defineFlow, reply } from '../../src/types/flow.js';
import { runFlow } from '../../src/flow/runFlow.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { CoreToolExecutor, defineTool, ToolValidationError } from '../../src/tools/effect/index.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { resolveReplyNode } from '../../src/flow/nodeBuilders.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';
import { SuspendError } from '../../src/runtime/durable/RunStore.js';
import { SAFE_DEGRADED_MESSAGE } from '../../src/flow/degrade.js';
import type { HarnessStreamPart } from '../../src/types/stream.js';

afterEach(() => {
  mock.restore();
});

describe('W1 recovery boundary', () => {
  it('action node throw completes runFlow without throwing (error event + graceful end)', async () => {
    const boom = action({
      id: 'boom',
      run: async () => {
        throw new Error('backend exploded');
      },
    });
    const flow = defineFlow({
      name: 'throw-flow',
      description: 'throws',
      start: boom,
      nodes: [boom],
    });

    const driver = {
      async runAgentTurn() {
        return { text: '', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'x' };
      },
    };

    const parts: HarnessStreamPart[] = [];
    const { session, runStore, runState } = await setupDurableHarness('w1-throw-sess', 'w1-throw-run');
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: (part) => parts.push(part),
    });

    const result = await runFlow(flow, runState, driver, ctx);

    expect(result).toEqual({ kind: 'ended', reason: 'error_degraded' });
    expect(parts.some((p) => p.type === 'error')).toBe(true);
    expect(parts.some((p) => p.type === 'text-delta' && p.delta === SAFE_DEGRADED_MESSAGE)).toBe(
      true,
    );
  });

  it('action throw with escalate node pauses on __escalate instead of error_degraded end', async () => {
    const boom = action({
      id: 'boom',
      run: async () => {
        throw new Error('needs human');
      },
    });
    const escalateNode = action({
      id: 'escalate',
      run: async () => ({ escalate: 'tool failure' }),
    });
    const flow = defineFlow({
      name: 'throw-escalate-flow',
      description: 'throws then escalate',
      start: boom,
      nodes: [boom, escalateNode],
    });

    const driver = {
      async runAgentTurn() {
        return { text: '', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'x' };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness('w1-esc-sess', 'w1-esc-run');
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
    });

    await expect(runFlow(flow, runState, driver, ctx)).rejects.toBeInstanceOf(SuspendError);

    const paused = (await runStore.getRunState(runState.runId))!;
    expect(paused.status).toBe('paused');
    expect(paused.waitingFor?.signalName).toBe('__escalate');
  });

  it('model tool call with bad args degrades in TextDriver without aborting the turn', async () => {
    let streamCall = 0;
    const strictTool = defineTool({
      name: 'faq_lookup',
      description: 'FAQ',
      input: z.object({ query: z.string() }),
      execute: async (args) => args,
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
              response: Promise.resolve({ messages: [] }),
              toolCalls: Promise.resolve([
                { toolName: 'faq_lookup', toolCallId: 'bad-1', input: undefined },
              ]),
            };
          }
          return {
            fullStream: (async function* () {
              yield Object.assign({ type: 'text-delta' }, { text: ' Sorry about that.' });
            })(),
            finishReason: Promise.resolve('stop'),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve([]),
          };
        },
      };
    });

    const parts: HarnessStreamPart[] = [];
    const { session, runStore, runState } = await setupDurableHarness('w1-bad-args-sess', 'w1-bad-args-run');
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: { faq_lookup: strictTool } }),
      model: stubModel,
      emit: (part) => parts.push(part),
    });

    const node = reply({ id: 'r', instructions: 'Help', next: () => ({ end: 'done' }) });
    const driver = new TextDriver({ toolDefs: { faq_lookup: strictTool } });
    const result = await driver.runAgentTurn(resolveReplyNode(node, {}), ctx);

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]?.result).toMatchObject({ error: true });
    expect(parts.some((p) => p.type === 'error')).toBe(true);
    expect(streamCall).toBe(2);
    expect(result.text).toContain('Sorry');
  });

  it('exceeding maxOscillations degrades without throwing', async () => {
    let nodeA!: ReturnType<typeof action>;
    let nodeB!: ReturnType<typeof action>;
    nodeB = action({ id: 'b', run: () => nodeA });
    nodeA = action({ id: 'a', run: () => nodeB });

    const flow = defineFlow({
      name: 'osc-degrade',
      description: 'Oscillates',
      start: nodeA,
      nodes: [nodeA, nodeB],
      maxOscillations: 2,
    });

    const driver = {
      async runAgentTurn() {
        return { text: '', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'x' };
      },
    };

    const parts: HarnessStreamPart[] = [];
    const { session, runStore, runState } = await setupDurableHarness('w1-osc-sess', 'w1-osc-run');
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: (part) => parts.push(part),
    });

    const result = await runFlow(flow, runState, driver, ctx);

    expect(result).toEqual({ kind: 'ended', reason: 'error_degraded' });
    expect(parts.some((p) => p.type === 'error')).toBe(true);
  });

  it('session remains usable for a next turn after error degradation', async () => {
    const boom = action({
      id: 'boom',
      run: async () => {
        throw new Error('transient');
      },
    });
    const after = reply({ id: 'after', instructions: 'Recover', next: () => ({ end: 'ok' }) });
    const flow = defineFlow({
      name: 'reuse-flow',
      description: 'reuse',
      start: boom,
      nodes: [boom, after],
    });

    const driver = {
      async runAgentTurn() {
        return { text: 'All good now', toolResults: [] };
      },
      async awaitUser() {
        return { type: 'message' as const, input: 'continue' };
      },
    };

    const { session, runStore, runState } = await setupDurableHarness('w1-reuse-sess', 'w1-reuse-run');
    const ctx1 = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
    });

    const first = await runFlow(flow, runState, driver, ctx1);
    expect(first).toEqual({ kind: 'ended', reason: 'error_degraded' });
    expect(runState.status).not.toBe('crashed');

    runState.activeFlow = 'reuse-flow';
    runState.activeNode = 'after';
    runState.status = 'running';
    await runStore.putRunState(runState);

    const ctx2 = await createRunContext({
      session,
      runState,
      runStore,
      steps: await runStore.getSteps(runState.runId),
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
    });

    const second = await runFlow(flow, runState, driver, ctx2);
    expect(second).toEqual({ kind: 'ended', reason: 'ok' });
  });

  it('classifyControl maps __escalate and __recover tool results', async () => {
    const { classifyControl } = await import('../../src/flow/classifyControl.js');

    expect(classifyControl({ __escalate: true, reason: 'human needed' })).toEqual({
      type: 'escalate',
      reason: 'human needed',
    });
    expect(classifyControl({ __recover: true, reason: 'retry later' })).toEqual({
      type: 'recover',
      reason: 'retry later',
    });
  });
});

describe('ToolValidationError is degradable at Runtime boundary', () => {
  it('isDegradableRuntimeError includes ToolValidationError', async () => {
    const { isDegradableRuntimeError } = await import('../../src/flow/degradableErrors.js');
    expect(isDegradableRuntimeError(new ToolValidationError('bad', []))).toBe(true);
  });
});
