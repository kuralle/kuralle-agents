import { describe, expect, it } from 'bun:test';
import { simulateReadableStream } from 'ai/test';
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
import { setupDurableHarness } from '../core-durable/helpers.js';
import {
  mockV3MultiStepStreamModel,
  mockV3ToolCallStreamResult,
} from '../helpers/mockLanguageModelV3Results.js';

const TOOL_CALLS_FINISH = { unified: 'tool-calls' as const, raw: undefined };

function mockUsage(inputTokens: number, outputTokens: number) {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTokens,
      text: outputTokens,
      reasoning: undefined,
    },
  };
}

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

    const model = mockV3MultiStepStreamModel([
      () => {
        streamCalls += 1;
        return mockV3ToolCallStreamResult(
          'submit_intake_data',
          'call-submit',
          JSON.stringify({ unitId: 'A-204' }),
          42,
        );
      },
      () => {
        streamCalls += 1;
        return mockV3ToolCallStreamResult(
          'submit_intake_data',
          'call-should-not-run',
          JSON.stringify({ unitId: 'B-105' }),
          99,
        );
      },
    ]);

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
      model,
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
    const model = mockV3MultiStepStreamModel([
      () => {
        streamCalls += 1;
        return mockV3ToolCallStreamResult(
          'submit_name_data',
          `submit-${streamCalls}`,
          JSON.stringify({ first: 'Ada' }),
          10,
        );
      },
      () => {
        streamCalls += 1;
        return mockV3ToolCallStreamResult(
          'submit_name_data',
          `submit-${streamCalls}`,
          JSON.stringify({ last: 'Lovelace' }),
          10,
        );
      },
    ]);

    const confirm = reply({ id: 'confirm', instructions: 'Confirm', next: () => ({ end: 'done' }) });
    const collectNode = collect({
      id: 'name',
      schema: z.object({ first: z.string(), last: z.string() }),
      required: ['first', 'last'],
      onComplete: () => confirm,
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
      model,
      emit: () => {},
    });

    const turn = await new TextDriver({ maxSteps: 3 }).runExtraction(resolved, ctx);
    mergeTurnExtraction(collectNode, runState.state, turn.toolResults);

    expect(streamCalls).toBe(2);
    expect(getCollectData(runState.state, 'name')).toEqual({ first: 'Ada', last: 'Lovelace' });
  });

  it('keeps both submit calls from one response and still breaks early', async () => {
    let streamCalls = 0;
    const model = mockV3MultiStepStreamModel([
      () => {
        streamCalls += 1;
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'submit-first',
                toolName: 'submit_name_data',
                input: JSON.stringify({ first: 'Ada' }),
              },
              {
                type: 'tool-call',
                toolCallId: 'submit-last',
                toolName: 'submit_name_data',
                input: JSON.stringify({ last: 'Lovelace' }),
              },
              { type: 'finish', finishReason: TOOL_CALLS_FINISH, usage: mockUsage(10, 1) },
            ],
          }),
        };
      },
    ]);

    const done = reply({ id: 'done', instructions: 'Done', next: () => ({ end: 'done' }) });
    const collectNode = collect({
      id: 'name',
      schema: z.object({ first: z.string(), last: z.string() }),
      required: ['first', 'last'],
      onComplete: () => done,
    });
    const submit = createExtractionSubmitTool(collectNode, ['first', 'last']);
    const resolved = resolveCollectExtractionNode(collectNode, ['first', 'last'], {}, submit);
    resolved.extractionSatisfied = (toolResults) =>
      wouldCollectSatisfyAfterToolResults(collectNode, {}, toolResults);

    const { session, runStore, runState } = await setupDurableHarness(
      'extract-double-submit',
      'extract-double-submit',
    );
    runState.messages = [{ role: 'user', content: 'Ada Lovelace' }];
    const ctx = await createRunContext({
      session,
      runStore,
      runState,
      steps: [],
      toolExecutor: new CoreToolExecutor({ tools: {} }),
      model,
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

    const model = mockV3MultiStepStreamModel([
      () => {
        streamCalls += 1;
        return mockV3ToolCallStreamResult(
          'submit_intake_data',
          `call-${streamCalls}`,
          JSON.stringify({ unitId: streamCalls === 1 ? 'A-204' : 'B-105' }),
          10,
        );
      },
      () => {
        streamCalls += 1;
        return mockV3ToolCallStreamResult(
          'submit_intake_data',
          `call-${streamCalls}`,
          JSON.stringify({ unitId: 'B-105' }),
          10,
        );
      },
    ]);

    const done = reply({ id: 'done', instructions: 'Done', next: () => ({ end: 'done' }) });
    const collectNode = collect({
      id: 'intake',
      schema: z.object({ unitId: z.string().min(1) }),
      required: ['unitId'],
      onComplete: () => done,
    });
    const { session, runStore, runState } = await setupDurableHarness(
      'extract-submit-error',
      'extract-submit-error',
    );
    runState.messages = [{ role: 'user', content: 'Unit please' }];
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
      model,
      emit: () => {},
    });

    const turn = await new TextDriver({ maxSteps: 3 }).runExtraction(resolved, ctx);
    mergeTurnExtraction(collectNode, runState.state, turn.toolResults);

    expect(streamCalls).toBe(2);
    expect(getCollectData(runState.state, 'intake')).toEqual({ unitId: 'B-105' });
    expect(turn.toolResults).toHaveLength(2);
  });
});
