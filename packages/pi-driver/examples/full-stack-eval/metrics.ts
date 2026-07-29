import type { StreamPart } from '@kuralle-agents/core';
import { assessScenario, type ScenarioAssessment, type ToolObservation } from './scenario.js';

export type DriverLabel = 'default' | 'pi';

export interface ModelCallObservation {
  callId: string;
  modelId: string;
  step: number;
  startedMs: number;
  durationMs?: number;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface BenchmarkRun {
  driver: DriverLabel;
  ordinal: number;
  sessionId: string;
  ttftMs: number | null;
  totalMs: number;
  answer: string;
  toolCalls: ToolObservation[];
  modelCalls: ModelCallObservation[];
  errors: string[];
  assessment: ScenarioAssessment;
}

export interface Distribution {
  mean: number;
  median: number;
  min: number;
  max: number;
}

export interface DriverSummary {
  driver: DriverLabel;
  runs: number;
  correct: number;
  ttftMs: Distribution;
  totalMs: Distribution;
  meanModelCalls: number;
  meanToolCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface BenchmarkComparison {
  default: DriverSummary;
  pi: DriverSummary;
  medianDelta: {
    ttftMs: number;
    totalMs: number;
  };
  pairedMedianDelta: {
    ttftMs: number;
    totalMs: number;
  };
  piVsDefaultPercent: {
    ttft: number;
    total: number;
  };
}

export class RunTelemetry {
  private readonly modelCalls: ModelCallObservation[] = [];
  private readonly toolCalls: Array<ToolObservation & { toolCallId?: string }> = [];
  private readonly errors: string[] = [];
  private text = '';
  private firstTextMs: number | null = null;

  observe(part: StreamPart, elapsedMs: number): void {
    if (part.type === 'text-delta') {
      this.firstTextMs ??= elapsedMs;
      this.text += part.payload.delta;
      return;
    }
    if (part.type === 'model-call-start') {
      this.modelCalls.push({
        callId: part.payload.callId,
        modelId: part.payload.modelId,
        step: part.payload.step,
        startedMs: elapsedMs,
      });
      return;
    }
    if (part.type === 'model-call-end') {
      const call = this.modelCalls.findLast((entry) => entry.callId === part.payload.callId);
      if (!call) return;
      call.durationMs = elapsedMs - call.startedMs;
      call.finishReason = part.payload.finishReason;
      call.inputTokens = part.payload.inputTokens;
      call.outputTokens = part.payload.outputTokens;
      call.cacheReadTokens = part.payload.cacheReadTokens;
      call.cacheWriteTokens = part.payload.cacheWriteTokens;
      return;
    }
    if (part.type === 'tool-call') {
      this.toolCalls.push({
        name: part.payload.toolName,
        args: part.payload.args,
        toolCallId: part.payload.toolCallId,
      });
      return;
    }
    if (part.type === 'tool-result' && !part.payload.preliminary) {
      const call = this.toolCalls.findLast((entry) =>
        entry.result === undefined && (
          part.payload.toolCallId
            ? entry.toolCallId === part.payload.toolCallId
            : entry.name === part.payload.toolName
        ));
      if (call) call.result = part.payload.result;
      return;
    }
    if (part.type === 'error') {
      this.errors.push(part.payload.error);
    }
  }

  finish(input: {
    driver: DriverLabel;
    ordinal: number;
    sessionId: string;
    totalMs: number;
    resultText: string;
  }): BenchmarkRun {
    const answer = input.resultText.trim() || this.text.trim();
    const toolCalls = this.toolCalls.map(({ toolCallId: _toolCallId, ...call }) => call);
    return {
      driver: input.driver,
      ordinal: input.ordinal,
      sessionId: input.sessionId,
      ttftMs: this.firstTextMs,
      totalMs: input.totalMs,
      answer,
      toolCalls,
      modelCalls: this.modelCalls,
      errors: this.errors,
      assessment: assessScenario(answer, toolCalls, this.errors),
    };
  }
}

export function summarizeBenchmark(runs: BenchmarkRun[]): BenchmarkComparison {
  const defaultRuns = runs.filter((run) => run.driver === 'default');
  const piRuns = runs.filter((run) => run.driver === 'pi');
  if (defaultRuns.length === 0 || piRuns.length === 0) {
    throw new Error('Benchmark requires at least one measured run for each driver.');
  }
  const defaultSummary = summarizeDriver('default', defaultRuns);
  const piSummary = summarizeDriver('pi', piRuns);
  const paired = defaultRuns.flatMap((baseline) => {
    const candidate = piRuns.find((run) => run.ordinal === baseline.ordinal);
    return candidate ? [{ baseline, candidate }] : [];
  });
  if (paired.length === 0) throw new Error('Benchmark has no paired driver runs.');

  return {
    default: defaultSummary,
    pi: piSummary,
    medianDelta: {
      ttftMs: piSummary.ttftMs.median - defaultSummary.ttftMs.median,
      totalMs: piSummary.totalMs.median - defaultSummary.totalMs.median,
    },
    pairedMedianDelta: {
      ttftMs: median(paired.map(({ baseline, candidate }) => requiredTtft(candidate) - requiredTtft(baseline))),
      totalMs: median(paired.map(({ baseline, candidate }) => candidate.totalMs - baseline.totalMs)),
    },
    piVsDefaultPercent: {
      ttft: percentDelta(piSummary.ttftMs.median, defaultSummary.ttftMs.median),
      total: percentDelta(piSummary.totalMs.median, defaultSummary.totalMs.median),
    },
  };
}

function summarizeDriver(driver: DriverLabel, runs: BenchmarkRun[]): DriverSummary {
  return {
    driver,
    runs: runs.length,
    correct: runs.filter((run) => run.assessment.passed).length,
    ttftMs: distribution(runs.map(requiredTtft)),
    totalMs: distribution(runs.map((run) => run.totalMs)),
    meanModelCalls: mean(runs.map((run) => run.modelCalls.length)),
    meanToolCalls: mean(runs.map((run) => run.toolCalls.length)),
    inputTokens: sum(runs.flatMap((run) => run.modelCalls.map((call) => call.inputTokens ?? 0))),
    outputTokens: sum(runs.flatMap((run) => run.modelCalls.map((call) => call.outputTokens ?? 0))),
  };
}

function requiredTtft(run: BenchmarkRun): number {
  if (run.ttftMs === null) throw new Error(`${run.driver} run ${run.ordinal} emitted no text.`);
  return run.ttftMs;
}

function distribution(values: number[]): Distribution {
  return {
    mean: mean(values),
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function mean(values: number[]): number {
  return sum(values) / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function percentDelta(candidate: number, baseline: number): number {
  return baseline === 0 ? 0 : ((candidate - baseline) / baseline) * 100;
}
