import { describe, expect, it } from 'bun:test';
import type { StreamPart } from '@kuralle-agents/core';
import type { LanguageModel } from 'ai';
import {
  EXPECTED,
  HashingEmbedder,
  assessScenario,
  buildScenarioAgent,
  type ScenarioAssessment,
  type ToolObservation,
} from '../examples/full-stack-eval/scenario.js';
import {
  RunTelemetry,
  summarizeBenchmark,
  type BenchmarkRun,
  type DriverLabel,
} from '../examples/full-stack-eval/metrics.js';

const TEST_MODEL = { provider: 'test', modelId: 'test-model' } as LanguageModel;

function completeTools(): ToolObservation[] {
  return [
    {
      name: 'load_skill',
      args: { name: 'incident-response' },
      result: `checkout spikes after deploy are ${EXPECTED.severity}`,
    },
    {
      name: 'read_skill_resource',
      args: { skill: 'incident-response', path: 'references/escalation.md' },
      result: `acknowledge within ${EXPECTED.acknowledgement}`,
    },
    {
      name: 'workspace',
      args: { op: 'cat', path: '/accounts/ACME-42.md' },
      result: `Region: ${EXPECTED.region}`,
    },
    {
      name: 'semantic_search',
      args: { query: 'checkout recovery after deploy' },
      result: `playbook ${EXPECTED.playbook}`,
    },
  ];
}

function completeAnswer(): string {
  return `${EXPECTED.region}, ${EXPECTED.severity}, ${EXPECTED.acknowledgement}, ${EXPECTED.playbook}`;
}

function passedAssessment(): ScenarioAssessment {
  return assessScenario(completeAnswer(), completeTools());
}

function benchmarkRun(
  driver: DriverLabel,
  ordinal: number,
  ttftMs: number,
  totalMs: number,
): BenchmarkRun {
  return {
    driver,
    ordinal,
    sessionId: `${driver}-${ordinal}`,
    ttftMs,
    totalMs,
    answer: completeAnswer(),
    toolCalls: completeTools(),
    modelCalls: [{
      callId: `${driver}-${ordinal}-call`,
      modelId: 'test-model',
      step: 0,
      startedMs: 0,
      durationMs: totalMs,
      inputTokens: 10,
      outputTokens: 5,
    }],
    errors: [],
    assessment: passedAssessment(),
  };
}

describe('full-stack evaluation scenario', () => {
  it('uses deterministic normalized embeddings', async () => {
    const embedder = new HashingEmbedder();
    const first = await embedder.embed('checkout deployment recovery');
    const second = await embedder.embed('checkout deployment recovery');
    const norm = Math.sqrt(first.reduce((sum, value) => sum + value * value, 0));

    expect(first).toEqual(second);
    expect(first).toHaveLength(embedder.dimension);
    expect(norm).toBeCloseTo(1, 10);
  });

  it('ranks the checkout playbook first through the real RAG pipeline', async () => {
    const { pipeline } = await buildScenarioAgent(TEST_MODEL);
    const results = await pipeline.retrieve('checkout recovery playbook after deployment', { topK: 1 });

    expect(results).toHaveLength(1);
    expect(results[0]?.text).toContain(EXPECTED.playbook);
  });

  it('requires every substrate call, returned evidence, and answer fact', () => {
    const complete = assessScenario(completeAnswer(), completeTools());
    const equivalentWording = assessScenario(
      `${EXPECTED.region}, ${EXPECTED.severity}, 15-minute response, ${EXPECTED.playbook}`,
      completeTools(),
    );
    const missingRag = assessScenario(completeAnswer(), completeTools().slice(0, -1));

    expect(complete).toMatchObject({ passed: true, score: complete.total });
    expect(equivalentWording.passed).toBe(true);
    expect(complete.total).toBe(14);
    expect(missingRag.passed).toBe(false);
    expect(missingRag.checks).toMatchObject({ searchedRag: false, ragEvidenceReturned: false });
  });
});

describe('full-stack evaluation telemetry', () => {
  it('derives TTFT, model duration, usage, and tool results from stream events', () => {
    const telemetry = new RunTelemetry();
    const parts: Array<{ part: StreamPart; elapsedMs: number }> = [
      {
        part: {
          channel: 'internal',
          type: 'model-call-start',
          payload: { callId: 'call-1', modelId: 'test-model', step: 0 },
        },
        elapsedMs: 10,
      },
      {
        part: {
          channel: 'internal',
          type: 'tool-call',
          payload: { toolName: 'workspace', args: { op: 'cat' }, toolCallId: 'tool-1' },
        },
        elapsedMs: 20,
      },
      {
        part: {
          channel: 'internal',
          type: 'tool-result',
          payload: { toolName: 'workspace', result: 'evidence', toolCallId: 'tool-1' },
        },
        elapsedMs: 30,
      },
      {
        part: {
          channel: 'internal',
          type: 'model-call-end',
          payload: {
            callId: 'call-1',
            finishReason: 'stop',
            inputTokens: 12,
            outputTokens: 4,
          },
        },
        elapsedMs: 40,
      },
      {
        part: {
          channel: 'client',
          type: 'text-delta',
          payload: { id: 'text-1', delta: 'answer' },
        },
        elapsedMs: 50,
      },
    ];
    for (const { part, elapsedMs } of parts) telemetry.observe(part, elapsedMs);

    const run = telemetry.finish({
      driver: 'default',
      ordinal: 1,
      sessionId: 'session-1',
      totalMs: 70,
      resultText: '',
    });

    expect(run).toMatchObject({ ttftMs: 50, totalMs: 70, answer: 'answer' });
    expect(run.modelCalls[0]).toMatchObject({ durationMs: 30, inputTokens: 12, outputTokens: 4 });
    expect(run.toolCalls[0]).toEqual({ name: 'workspace', args: { op: 'cat' }, result: 'evidence' });
  });

  it('summarizes paired latency and token accounting independently by driver', () => {
    const summary = summarizeBenchmark([
      benchmarkRun('default', 1, 100, 500),
      benchmarkRun('pi', 1, 80, 450),
      benchmarkRun('pi', 2, 120, 600),
      benchmarkRun('default', 2, 200, 700),
    ]);

    expect(summary.default).toMatchObject({
      correct: 2,
      ttftMs: { median: 150 },
      totalMs: { median: 600 },
      inputTokens: 20,
      outputTokens: 10,
    });
    expect(summary.pi).toMatchObject({
      correct: 2,
      ttftMs: { median: 100 },
      totalMs: { median: 525 },
      inputTokens: 20,
      outputTokens: 10,
    });
    expect(summary.medianDelta).toEqual({ ttftMs: -50, totalMs: -75 });
    expect(summary.pairedMedianDelta).toEqual({ ttftMs: -50, totalMs: -75 });
    expect(summary.piVsDefaultPercent).toEqual({
      ttft: -33.33333333333333,
      total: -12.5,
    });
  });
});
