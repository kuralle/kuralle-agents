import { describe, expect, it } from 'bun:test';
import { decide, reply } from '../../src/types/flow.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { defineTool, CoreToolExecutor } from '../../src/tools/effect/index.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { resolveReplyNode } from '../../src/flow/nodeBuilders.js';
import { createEventBus, createTurnHandle } from '../../src/events/TurnHandle.js';
import { setupDurableHarness } from '../core-durable/helpers.js';
import type { RunState } from '../../src/runtime/durable/types.js';
import type { StreamPart } from '../../src/types/stream.js';
import type { ValidationCapability } from '../../src/capabilities/ValidationCapability.js';
import { z } from 'zod';
import { buildChoiceEnumSchema, isConstrainedChoiceEnumSchema } from '../../src/flow/choiceMatch.js';
import {
  mockV3GenerateObjectModel,
  mockV3MultiStepStreamModel,
  mockV3StreamResult,
  mockV3StreamTextModel,
  mockV3ToolCallStreamResult,
} from '../helpers/mockLanguageModelV3Results.js';

const TEXT_LIFECYCLE = new Set(['text-start', 'text-delta', 'text-end', 'text-cancel']);

function withUserMessage(runState: RunState) {
  runState.messages = [{ role: 'user', content: 'hello' }];
}

describe('TextDriver unit', () => {
  it('streams text-delta events and returns TurnResult', async () => {
    const model = mockV3StreamTextModel(['Hello', ' world']);

    const { session, runStore, runState } = await setupDurableHarness();
    withUserMessage(runState);
    const parts: StreamPart[] = [];
    const toolExecutor = new CoreToolExecutor({ tools: {} });

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor,
      model,
      emit: (p) => parts.push(p),
    });

    const node = reply({ id: 'greet', instructions: 'Say hello' });
    const driver = new TextDriver();
    const result = await driver.runAgentTurn(resolveReplyNode(node, {}), ctx);

    expect(result.text).toBe('Hello world');
    expect(parts.filter((p) => p.type === 'text-delta').map((p) => p.payload.delta).join('')).toBe('Hello world');
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

    const model = mockV3MultiStepStreamModel([
      () => {
        streamCall += 1;
        return mockV3ToolCallStreamResult(
          'echo',
          'call-1',
          JSON.stringify({ value: 'test' }),
        );
      },
      () => {
        streamCall += 1;
        return mockV3StreamResult(' Done');
      },
    ]);

    const toolExecutor = new CoreToolExecutor({ tools: { echo: echoTool } });
    const { session, runStore, runState } = await setupDurableHarness();
    withUserMessage(runState);

    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor,
      model,
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
    const model = mockV3StreamTextModel('Hi');

    const bus = createEventBus();
    const { session, runStore, runState } = await setupDurableHarness();
    withUserMessage(runState);
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
          model,
          emit: (p) => bus.emit(p),
        });
        const driver = new TextDriver();
        return driver.runAgentTurn(
          resolveReplyNode(reply({ id: 'r', instructions: 'Hi' }), {}),
          ctx,
        );
      },
    });

    const collected: StreamPart[] = [];
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
      const model = mockV3StreamTextModel(chunks);

      const parts: StreamPart[] = [];
      const { session, runStore, runState } = await setupDurableHarness();
      withUserMessage(runState);
      const ctx = await createRunContext({
        session,
        runState,
        runStore,
        steps: [],
        toolExecutor: new CoreToolExecutor({ tools: {} }),
        model,
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
      const model = mockV3StreamTextModel(chunks);

      const turnPolicy: ValidationCapability = {
        name: 'turn-buffer',
        validate: async () => ({ decision: 'continue', confidence: 1 }),
      };

      const parts: StreamPart[] = [];
      const { session, runStore, runState } = await setupDurableHarness();
      withUserMessage(runState);
      const ctx = await createRunContext({
        session,
        runState,
        runStore,
        steps: [],
        toolExecutor: new CoreToolExecutor({ tools: {} }),
        model,
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
      const model = mockV3StreamTextModel([leaked.slice(0, 6), leaked.slice(6)]);

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

      const parts: StreamPart[] = [];
      const { session, runStore, runState } = await setupDurableHarness();
      withUserMessage(runState);
      const ctx = await createRunContext({
        session,
        runState,
        runStore,
        steps: [],
        toolExecutor: new CoreToolExecutor({ tools: {} }),
        model,
        validationPolicies: [blockPolicy],
        emit: (p) => parts.push(p),
      });

      const node = reply({ id: 'blocked', instructions: 'Answer' });
      const result = await new TextDriver().runAgentTurn(resolveReplyNode(node, {}), ctx);

      expect(result.text).toBe('safe only');
      const streamText = parts
        .filter((p) => p.type === 'text-delta')
        .map((p) => p.payload.delta)
        .join('');
      expect(streamText).not.toContain('LEAKED');
      expect(streamText).toBe('safe only');
    });

    it('REQ-12: runExtraction emits zero text lifecycle events', async () => {
      const model = mockV3StreamTextModel('would speak');

      const parts: StreamPart[] = [];
      const { session, runStore, runState } = await setupDurableHarness();
      withUserMessage(runState);
      const ctx = await createRunContext({
        session,
        runState,
        runStore,
        steps: [],
        toolExecutor: new CoreToolExecutor({ tools: {} }),
        model,
        emit: (p) => parts.push(p),
      });

      const node = reply({ id: 'extract', instructions: 'Extract only' });
      await new TextDriver().runExtraction(resolveReplyNode(node, {}), ctx);

      expect(parts.filter((p) => TEXT_LIFECYCLE.has(p.type))).toHaveLength(0);
    });
  });

  it('runStructured uses a closed enum schema for choice-decides', async () => {
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
    const choiceSchema = buildChoiceEnumSchema(node.choices);
    expect(isConstrainedChoiceEnumSchema(choiceSchema)).toBe(true);
    expect(choiceSchema.safeParse({ choice: 'bogus' }).success).toBe(false);

    const model = mockV3GenerateObjectModel(async () => ({ object: { choice: 'checkout' } }));

    const { session, runStore, runState } = await setupDurableHarness();
    runState.messages = [{ role: 'user', content: 'something unrelated entirely' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model,
      emit: () => {},
    });

    await new TextDriver().runStructured(node, ctx);
  });
});
