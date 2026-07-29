#!/usr/bin/env bun
import { createOpenAI } from '@ai-sdk/openai';
import { createModels } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import type { createRuntime } from '@kuralle-agents/core';
import { config as loadEnv } from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiDriver } from '../../src/index.js';
import {
  buildScenarioAgent,
  createScenarioRuntime,
  MODEL_ID,
  RAG_DOCUMENTS,
  REQUIRED_TOOLS,
  TASK,
} from './scenario.js';
import {
  RunTelemetry,
  summarizeBenchmark,
  type BenchmarkRun,
  type DriverLabel,
} from './metrics.js';

const exampleDir = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(exampleDir, '../../../../.env'), quiet: true });

const runsPerDriver = positiveInteger(process.env.PI_EVAL_RUNS, 3, 'PI_EVAL_RUNS');
const warmupsPerDriver = nonNegativeInteger(process.env.PI_EVAL_WARMUPS, 1, 'PI_EVAL_WARMUPS');
const outputPath = resolve(
  exampleDir,
  process.env.PI_EVAL_OUTPUT?.trim() || 'results/latest.json',
);

type ScenarioRuntime = ReturnType<typeof createRuntime>;

async function executeRun(
  runtime: ScenarioRuntime,
  driver: DriverLabel,
  ordinal: number,
  phase: 'warmup' | 'measured',
): Promise<BenchmarkRun> {
  const sessionId = `pi-loop-eval-${phase}-${driver}-${ordinal}-${crypto.randomUUID()}`;
  const telemetry = new RunTelemetry();
  const started = performance.now();
  const handle = runtime.run({ sessionId, input: TASK });
  for await (const part of handle.events) {
    telemetry.observe(part, performance.now() - started);
  }
  const result = await handle;
  const observation = telemetry.finish({
    driver,
    ordinal,
    sessionId,
    totalMs: performance.now() - started,
    resultText: result.text,
  });
  printRun(observation, phase);
  return observation;
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY is required in the repository root .env file.');

  const openai = createOpenAI({ apiKey });
  const aiSdkModel = openai(MODEL_ID);
  const models = createModels();
  models.setProvider(openaiProvider());
  const piModel = models.getModel('openai', MODEL_ID);
  if (!piModel) throw new Error(`Pi did not register openai:${MODEL_ID}.`);

  const { agent, pipeline } = await buildScenarioAgent(aiSdkModel);
  const retrievalProbe = await pipeline.retrieve('checkout recovery playbook after deployment', { topK: 1 });
  if (!retrievalProbe[0]?.text.includes('ORBIT-7')) {
    throw new Error('RAG preflight failed: checkout recovery did not rank ORBIT-7 first.');
  }

  const runtimes: Record<DriverLabel, ScenarioRuntime> = {
    default: createScenarioRuntime(agent),
    pi: createScenarioRuntime(agent, new PiDriver({
      model: piModel,
      models,
      getApiKey: () => apiKey,
      maxSteps: 10,
    })),
  };

  console.log('Kuralle full-stack loop evaluation');
  console.log(`model: openai:${MODEL_ID}`);
  console.log(`measured runs per driver: ${runsPerDriver}; warmups: ${warmupsPerDriver}`);
  console.log(`required tools: ${REQUIRED_TOOLS.join(', ')}`);
  console.log('same agent/corpus/task for both drivers\n');

  const warmups: BenchmarkRun[] = [];
  for (let ordinal = 0; ordinal < warmupsPerDriver; ordinal += 1) {
    const order: DriverLabel[] = ordinal % 2 === 0 ? ['default', 'pi'] : ['pi', 'default'];
    for (const driver of order) {
      const warmup = await executeRun(runtimes[driver], driver, ordinal, 'warmup');
      warmups.push(warmup);
      if (!warmup.assessment.passed) printCorrectnessWarning(warmup, 'warmup');
    }
  }

  const measured: BenchmarkRun[] = [];
  for (let ordinal = 1; ordinal <= runsPerDriver; ordinal += 1) {
    const order: DriverLabel[] = ordinal % 2 === 1 ? ['default', 'pi'] : ['pi', 'default'];
    for (const driver of order) {
      measured.push(await executeRun(runtimes[driver], driver, ordinal, 'measured'));
    }
  }

  const comparison = summarizeBenchmark(measured);
  printSummary(comparison);

  const artifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    model: `openai:${MODEL_ID}`,
    configuration: {
      runsPerDriver,
      warmupsPerDriver,
      alternatingOrder: true,
      ttftDefinition: 'milliseconds from runtime.run() to the first client text-delta',
      defaultDriver: 'Kuralle TextDriver using Vercel AI SDK',
      candidateDriver: '@kuralle-agents/pi-driver using @earendil-works/pi-agent-core',
    },
    substrate: {
      core: true,
      fs: 'InMemoryFs + createFsTool',
      skills: 'fsSkillStore + SKILL.md body + reference',
      rag: `RagPipeline + InMemoryVectorStore + HashingEmbedder (${RAG_DOCUMENTS.length} documents)`,
      tools: 'createVectorRetrievalTool',
    },
    task: TASK,
    requiredTools: REQUIRED_TOOLS,
    comparison,
    warmups,
    runs: measured,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  console.log(`\nresult artifact: ${outputPath}`);

  const failed = measured.filter((run) => !run.assessment.passed);
  if (failed.length > 0) {
    const details = failed.map((run) => {
      const missing = Object.entries(run.assessment.checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => name)
        .join(', ');
      return `${run.driver}#${run.ordinal}: ${missing}`;
    });
    throw new Error(`Benchmark correctness failed:\n${details.join('\n')}`);
  }
}

function printRun(run: BenchmarkRun, phase: 'warmup' | 'measured'): void {
  const ttft = run.ttftMs === null ? 'none' : `${Math.round(run.ttftMs)}ms`;
  const tools = run.toolCalls.map((call) => call.name).join(', ') || 'none';
  console.log(
    `${phase.padEnd(8)} ${run.driver.padEnd(7)} #${run.ordinal}: ` +
    `TTFT=${ttft.padStart(7)} total=${`${Math.round(run.totalMs)}ms`.padStart(7)} ` +
    `modelCalls=${run.modelCalls.length} tools=${run.toolCalls.length} ` +
    `score=${run.assessment.score}/${run.assessment.total}`,
  );
  console.log(`         tool trace: ${tools}`);
  console.log(`         answer: ${run.answer.replace(/\s+/g, ' ').slice(0, 220)}`);
}

function printSummary(comparison: ReturnType<typeof summarizeBenchmark>): void {
  console.log('\nComparison (measured runs only)');
  console.log('driver   correct  median TTFT  median total  avg model calls  avg tool calls');
  for (const summary of [comparison.default, comparison.pi]) {
    console.log(
      `${summary.driver.padEnd(8)}` +
      `${`${summary.correct}/${summary.runs}`.padEnd(9)}` +
      `${`${Math.round(summary.ttftMs.median)}ms`.padEnd(13)}` +
      `${`${Math.round(summary.totalMs.median)}ms`.padEnd(14)}` +
      `${summary.meanModelCalls.toFixed(1).padEnd(17)}` +
      summary.meanToolCalls.toFixed(1),
    );
  }
  console.log(
    `Pi vs default medians: TTFT ${signed(comparison.medianDelta.ttftMs)}ms ` +
    `(${signed(comparison.piVsDefaultPercent.ttft)}%), total ${signed(comparison.medianDelta.totalMs)}ms ` +
    `(${signed(comparison.piVsDefaultPercent.total)}%).`,
  );
  console.log(
    `Median of paired Pi-default deltas: TTFT ${signed(comparison.pairedMedianDelta.ttftMs)}ms, ` +
    `total ${signed(comparison.pairedMedianDelta.totalMs)}ms.`,
  );
}

function printCorrectnessWarning(run: BenchmarkRun, phase: string): void {
  const missing = Object.entries(run.assessment.checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  console.warn(`${phase} ${run.driver} correctness warning: ${missing.join(', ')}`);
}

function signed(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(raw: string | undefined, fallback: number, name: string): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
