import { afterEach, describe, expect, it, mock } from 'bun:test';
import { z } from 'zod';
import { collect, defineFlow, reply } from '../../src/types/flow.js';
import { TextDriver } from '../../src/runtime/channels/TextDriver.js';
import { defineTool, CoreToolExecutor } from '../../src/tools/effect/index.js';
import { createRunContext } from '../../src/runtime/ctx.js';
import { resolveCollectExtractionNode } from '../../src/flow/nodeBuilders.js';
import {
  createExtractionSubmitTool,
  getCollectData,
  mergeTurnExtraction,
  wouldCollectSatisfyAfterToolResults,
} from '../../src/flow/extraction.js';
import { setupDurableHarness, stubModel } from '../core-durable/helpers.js';

afterEach(() => {
  mock.restore();
});

describe('runSilentExtraction early break', () => {
  it('stops after submit tool returns (exactly one streamText, merged data unchanged)', async () => {
    let streamCalls = 0;
    const replyNode = reply({
      id: 'confirm',
      instructions: 'Confirm',
      next: () => ({ end: 'done' }),
    });
    const collectNode = collect({
      id: 'intake',
      schema: z.object({ unitId: z.string().min(1) }),
      required: ['unitId'],
      onComplete: () => replyNode,
    });
    defineFlow({
      name: 'intake-flow',
      description: 'Intake',
      start: collectNode,
      nodes: [collectNode, replyNode],
    });

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
                  toolName: 'submit_intake_data',
                  toolCallId: 'call-submit',
                  input: { unitId: 'A-204' },
                },
              ]),
              totalUsage: Promise.resolve({ inputTokens: 42, outputTokens: 7, totalTokens: 49 }),
            };
          }
          return {
            fullStream: (async function* () {})(),
            finishReason: Promise.resolve('stop'),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve([]),
            totalUsage: Promise.resolve({ inputTokens: 99, outputTokens: 9, totalTokens: 108 }),
          };
        },
      };
    });

    const submitTool = createExtractionSubmitTool(collectNode, ['unitId']);
    const { session, runStore, runState } = await setupDurableHarness('extract-break', 'extract-break');
    const resolved = resolveCollectExtractionNode(collectNode, ['unitId'], {}, submitTool);
    resolved.extractionSatisfied = (toolResults) =>
      wouldCollectSatisfyAfterToolResults(collectNode, runState.state, toolResults);
    runState.messages = [{ role: 'user', content: 'Unit A-204' }];
    const ctx = await createRunContext({
      session,
      runState,
      runStore,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
    });

    const driver = new TextDriver();
    const result = await driver.runExtraction(resolved, ctx);

    expect(streamCalls).toBe(1);
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]?.name).toBe('submit_intake_data');
    expect(result.toolResults[0]?.result).toEqual({ unitId: 'A-204' });
    expect(result.usage?.inputTokens).toBe(42);
  });

  it('continues extraction across steps until all required fields are collected', async () => {
    let streamCalls = 0;
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: () => {
          streamCalls += 1;
          const field = streamCalls === 1 ? { first: 'Ada' } : { last: 'Lovelace' };
          return {
            fullStream: (async function* () {})(),
            finishReason: Promise.resolve('tool-calls'),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve([
              {
                toolName: 'submit_name_data',
                toolCallId: `submit-${streamCalls}`,
                input: field,
              },
            ]),
            totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 1, totalTokens: 11 }),
          };
        },
      };
    });

    const collectNode = collect({
      id: 'name',
      schema: z.object({ first: z.string(), last: z.string() }),
      required: ['first', 'last'],
      onComplete: () =>
        reply({ id: 'confirm', instructions: 'Confirm', next: () => ({ end: 'done' }) }),
    });
    const submit = createExtractionSubmitTool(collectNode, ['first', 'last']);
    const { session, runStore, runState } = await setupDurableHarness(
      'extract-two-step',
      'extract-two-step',
    );
    runState.messages = [{ role: 'user', content: 'Ada Lovelace' }];
    const resolved = resolveCollectExtractionNode(collectNode, ['first', 'last'], runState.state, submit);
    resolved.extractionSatisfied = (toolResults) =>
      wouldCollectSatisfyAfterToolResults(collectNode, runState.state, toolResults);

    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
    });

    const turn = await new TextDriver({ maxSteps: 3 }).runExtraction(resolved, ctx);
    mergeTurnExtraction(collectNode, runState.state, turn.toolResults);

    expect(streamCalls).toBe(2);
    expect(getCollectData(runState.state, 'name')).toEqual({ first: 'Ada', last: 'Lovelace' });
  });

  it('keeps both submit calls from one response and still breaks early', async () => {
    let streamCalls = 0;
    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: () => {
          streamCalls += 1;
          return {
            fullStream: (async function* () {})(),
            finishReason: Promise.resolve('tool-calls'),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve([
              {
                toolName: 'submit_name_data',
                toolCallId: 'submit-first',
                input: { first: 'Ada' },
              },
              {
                toolName: 'submit_name_data',
                toolCallId: 'submit-last',
                input: { last: 'Lovelace' },
              },
            ]),
            totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 1, totalTokens: 11 }),
          };
        },
      };
    });

    const collectNode = collect({
      id: 'name',
      schema: z.object({ first: z.string(), last: z.string() }),
      required: ['first', 'last'],
      onComplete: () => reply({ id: 'done', instructions: 'Done', next: () => ({ end: 'done' }) }),
    });
    const submit = createExtractionSubmitTool(collectNode, ['first', 'last']);
    const resolved = resolveCollectExtractionNode(collectNode, ['first', 'last'], {}, submit);
    resolved.extractionSatisfied = (toolResults) =>
      wouldCollectSatisfyAfterToolResults(collectNode, {}, toolResults);

    const { session, runStore, runState } = await setupDurableHarness(
      'extract-double-submit',
      'extract-double-submit',
    );
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model: stubModel,
      emit: () => {},
    });

    const turn = await new TextDriver({ maxSteps: 3 }).runExtraction(resolved, ctx);
    mergeTurnExtraction(collectNode, runState.state, turn.toolResults);

    expect(streamCalls).toBe(1);
    expect(turn.toolResults).toHaveLength(2);
    expect(getCollectData(runState.state, 'name')).toEqual({ first: 'Ada', last: 'Lovelace' });
  });

  it('does not break when submit returns an error', async () => {
    let streamCalls = 0;
    let executeCalls = 0;
    const flakySubmit = defineTool({
      name: 'submit_intake_data',
      description: 'submit',
      input: z.object({ unitId: z.string() }),
      execute: async (args) => {
        executeCalls += 1;
        if (executeCalls === 1) {
          throw new Error('submit failed');
        }
        return args;
      },
    });

    mock.module('ai', () => {
      const actual = require('ai');
      return {
        ...actual,
        streamText: () => {
          streamCalls += 1;
          const unitId = streamCalls === 1 ? 'A-204' : 'B-105';
          return {
            fullStream: (async function* () {})(),
            finishReason: Promise.resolve('tool-calls'),
            response: Promise.resolve({ messages: [] }),
            toolCalls: Promise.resolve([
              {
                toolName: 'submit_intake_data',
                toolCallId: `call-${streamCalls}`,
                input: { unitId },
              },
            ]),
            totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 1, totalTokens: 11 }),
          };
        },
      };
    });

    const collectNode = collect({
      id: 'intake',
      schema: z.object({ unitId: z.string().min(1) }),
      required: ['unitId'],
      onComplete: () => reply({ id: 'done', instructions: 'Done', next: () => ({ end: 'done' }) }),
    });
    const { session, runStore, runState } = await setupDurableHarness(
      'extract-submit-error',
      'extract-submit-error',
    );
    const resolved = resolveCollectExtractionNode(
      collectNode,
      ['unitId'],
      {},
      flakySubmit as ReturnType<typeof createExtractionSubmitTool>,
    );
    resolved.extractionSatisfied = (toolResults) =>
      wouldCollectSatisfyAfterToolResults(collectNode, runState.state, toolResults);

    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: { submit_intake_data: flakySubmit } }),
      model: stubModel,
      emit: () => {},
    });

    const turn = await new TextDriver({ maxSteps: 3 }).runExtraction(resolved, ctx);
    mergeTurnExtraction(collectNode, runState.state, turn.toolResults);

    expect(streamCalls).toBe(2);
    expect(getCollectData(runState.state, 'intake')).toEqual({ unitId: 'B-105' });
    expect(turn.toolResults).toHaveLength(2);
  });
});
