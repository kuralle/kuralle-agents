#!/usr/bin/env bun
import type { AgentSpan, AgentTrace } from '@kuralle-agents/core';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_SCENARIOS, CORE_FLOW_SCENARIOS, type StressScenario } from './scenarios.js';

type DriverName = 'ai-sdk' | 'pi';

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ScenarioResult {
  scenario: string;
  source: string;
  driver: DriverName;
  sessionId: string;
  passed: boolean;
  checks: Record<string, boolean>;
  failures: string[];
  traceCount: number;
  traceIds: string[];
  ttftMs: number[];
  totalMs: number[];
  toolCalls: string[];
  spanKinds: string[];
  answers: string[];
  cli: { code: number; stdout: string; stderr: string };
}

const appDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(appDir, '../../..');
const cliPath = resolve(repoRoot, 'packages/cli/src/cli.ts');
const launcherPath = resolve(appDir, 'launcher.ts');
const selectedScenarios = selectRepeated('--scenario');
const selectedDrivers = selectDrivers();
const modelId = option('--model') ?? process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';

async function main(): Promise<void> {
  await assertScenarioInventory();
  if (!process.env.OPENAI_API_KEY?.trim()) {
    // launcher also loads the root .env; this early check is intentionally soft.
    const dotenv = await import('dotenv');
    dotenv.config({ path: resolve(repoRoot, '.env'), quiet: true });
  }
  if (!process.env.OPENAI_API_KEY?.trim()) throw new Error('OPENAI_API_KEY is required in the repository root .env file.');

  const scenarios = selectedScenarios.length === 0
    ? ALL_SCENARIOS
    : selectedScenarios.map(findScenario);
  const generatedAt = new Date();
  const runDir = resolve(appDir, 'results', generatedAt.toISOString().replaceAll(':', '-'));
  await mkdir(runDir, { recursive: true });

  const collector = await startOtlpCollector();
  const results: ScenarioResult[] = [];
  try {
    console.log('Kuralle CLI dual-driver stress');
    console.log(`model: openai:${modelId}`);
    console.log(`scenarios: ${scenarios.map((item) => item.id).join(', ')}`);
    console.log(`drivers: ${selectedDrivers.join(', ')}`);
    console.log(`OTLP: ${collector.endpoint}\n`);

    let ordinal = 0;
    for (const scenario of scenarios) {
      for (const driver of selectedDrivers) {
        ordinal += 1;
        const result = await runScenario({
          scenario,
          driver,
          runDir,
          otlpEndpoint: collector.endpoint,
          ordinal,
        });
        results.push(result);
        printResult(result);
      }
    }

    await collector.settle();
    const otlp = assessOtlp(results, collector.payloads);
    const artifact = buildArtifact(generatedAt, results, otlp, collector.payloads.length);
    await writeFile(resolve(runDir, 'report.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    await writeFile(resolve(appDir, 'results/latest.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    printSummary(results, otlp, runDir);

    if (results.some((result) => !result.passed) || !otlp.passed) process.exitCode = 1;
  } finally {
    await collector.close();
  }
}

async function runScenario(args: {
  scenario: StressScenario;
  driver: DriverName;
  runDir: string;
  otlpEndpoint: string;
  ordinal: number;
}): Promise<ScenarioResult> {
  const { scenario, driver, runDir, otlpEndpoint, ordinal } = args;
  const stem = `${String(ordinal).padStart(2, '0')}-${scenario.id}-${driver}`;
  const storePath = resolve(runDir, `${stem}.session.json`);
  const sessionId = `stress-${scenario.id}-${driver}-${crypto.randomUUID()}`;
  const env = {
    ...process.env,
    KURALLE_STRESS_SCENARIO: scenario.id,
    KURALLE_STRESS_SOURCE: scenario.source,
    KURALLE_STRESS_DRIVER: driver,
    KURALLE_STRESS_OTLP_ENDPOINT: otlpEndpoint,
    KURALLE_EXAMPLE_PROVIDER: 'openai',
    OPENAI_MODEL: modelId,
    NO_COLOR: '1',
  };

  const chat = await command([
    process.execPath,
    cliPath,
    'chat',
    '--agent', launcherPath,
    '--auto', scenario.prompts.join('|'),
    '--trace',
    '--store', storePath,
    '--session', sessionId,
  ], env);

  const trace = await command([
    process.execPath,
    cliPath,
    'trace', sessionId,
    '--agent', launcherPath,
    '--store', storePath,
    '--json',
  ], env);

  let traces: AgentTrace[] = [];
  let traceParseError: string | undefined;
  try {
    traces = JSON.parse(trace.stdout) as AgentTrace[];
    if (!Array.isArray(traces)) throw new Error('trace output was not an array');
  } catch (error) {
    traceParseError = error instanceof Error ? error.message : String(error);
  }

  const assessed = assessScenario(scenario, traces, chat.code, trace.code, traceParseError);
  const result: ScenarioResult = {
    scenario: scenario.id,
    source: scenario.source,
    driver,
    sessionId,
    passed: assessed.failures.length === 0,
    checks: assessed.checks,
    failures: assessed.failures,
    traceCount: traces.length,
    traceIds: traces.map((traceItem) => traceItem.traceId),
    ttftMs: traces.map(turnTtft).filter((value): value is number => value !== undefined),
    totalMs: traces.map(traceDuration),
    toolCalls: [...new Set(traces.flatMap((item) => item.toolCalls.map((call) => call.name)))],
    spanKinds: [...new Set(traces.flatMap((item) => item.spans.map((span) => span.kind)))],
    answers: traces.map((item) => item.answer),
    cli: {
      code: chat.code,
      stdout: stripAnsi(chat.stdout).slice(-12_000),
      stderr: stripAnsi([chat.stderr, trace.stderr, traceParseError].filter(Boolean).join('\n')).slice(-12_000),
    },
  };
  await writeFile(resolve(runDir, `${stem}.result.json`), `${JSON.stringify({ ...result, traces }, null, 2)}\n`, 'utf8');
  return result;
}

export function assessScenario(
  scenario: StressScenario,
  traces: AgentTrace[],
  chatCode = 0,
  traceCode = 0,
  parseError?: string,
): { checks: Record<string, boolean>; failures: string[] } {
  const spans = traces.flatMap((trace) => trace.spans);
  const tools = traces.flatMap((trace) => trace.toolCalls.map((call) => call.name));
  const answers = traces.map((trace) => trace.answer).join('\n').toLowerCase();
  const expectation = scenario.expectation;
  const checks: Record<string, boolean> = {
    chatExitedCleanly: chatCode === 0,
    traceExitedCleanly: traceCode === 0,
    traceJsonParsed: !parseError,
    oneTracePerPrompt: traces.length === scenario.prompts.length,
    everyTurnCompleted: traces.length > 0 && traces.every((trace) => trace.endedAt !== undefined),
    everyTurnHasText: traces.length > 0 && traces.every((trace) => trace.answer.trim().length > 0),
    everyTurnHasTtft: traces.length > 0 && traces.every((trace) => turnTtft(trace) !== undefined),
    noErrorSpans: spans.every((span) => span.status !== 'error'),
  };

  for (const flow of expectation.flows ?? []) {
    checks[`flow:${flow}`] = spans.some((span) =>
      span.kind === 'flow' && (span.attributes.activeFlow === flow || span.name === `flow:${flow}`));
  }
  for (const tool of expectation.tools ?? []) checks[`tool:${tool}`] = tools.includes(tool);
  for (const value of expectation.answerIncludes ?? []) {
    checks[`answer:${value}`] = answers.includes(value.toLowerCase());
  }
  if (expectation.requireHandoff) checks.handoff = spans.some((span) => span.kind === 'handoff');
  if (expectation.requireParallelTools) {
    checks.parallelToolOverlap = hasParallelOverlap(spans, expectation.requireParallelTools);
  }

  const failures = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([check]) => check);
  return { checks, failures };
}

function hasParallelOverlap(spans: AgentSpan[], required: string[]): boolean {
  const candidates = required.map((name) => spans.filter((span) =>
    span.kind === 'tool' && span.attributes.toolName === name && span.endTime !== undefined));
  if (candidates.some((list) => list.length === 0)) return false;
  const choose = (index: number, selected: AgentSpan[]): boolean => {
    if (index === candidates.length) {
      return Math.max(...selected.map((span) => span.startTime))
        < Math.min(...selected.map((span) => span.endTime!));
    }
    return candidates[index]!.some((span) => choose(index + 1, [...selected, span]));
  };
  return choose(0, []);
}

interface OtlpAssessment {
  passed: boolean;
  checks: Record<string, boolean>;
  failures: string[];
  spanCount: number;
  kinds: string[];
}

function assessOtlp(results: ScenarioResult[], payloads: unknown[]): OtlpAssessment {
  const spans = payloads.flatMap(extractOtlpSpans);
  const traceIds = new Set(spans.map((span) => String(span.traceId)));
  const expectedTraceIds = results.flatMap((result) => result.traceIds);
  // Each scenario result carries metrics rather than full traces; the OTLP turn
  // count is therefore checked against the number of persisted CLI turns.
  const expectedTurns = results.reduce((sum, result) => sum + result.traceCount, 0);
  const turnSpans = spans.filter((span) => otlpKind(span) === 'turn');
  const kinds = [...new Set(spans.map(otlpKind).filter(Boolean))];
  const checks: Record<string, boolean> = {
    receivedPayloads: payloads.length > 0,
    everyCliTraceExported: expectedTraceIds.length === expectedTurns
      && expectedTraceIds.every((traceId) => traceIds.has(traceId)),
    oneOtlpTurnPerCliTrace: expectedTraceIds.every((traceId) =>
      turnSpans.some((span) => span.traceId === traceId)),
    ttftExported: expectedTraceIds.length > 0 && expectedTraceIds.every((traceId) =>
      turnSpans.some((span) => span.traceId === traceId && hasOtlpTtft(span))),
    semanticKindsExported: ['turn', 'flow', 'node', 'tool', 'llm'].every((kind) => kinds.includes(kind)),
  };
  if (results.some((result) => result.checks.handoff !== undefined)) {
    checks.handoffKindExported = kinds.includes('handoff');
  }
  const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return { passed: failures.length === 0, checks, failures, spanCount: spans.length, kinds };
}

function buildArtifact(
  generatedAt: Date,
  results: ScenarioResult[],
  otlp: OtlpAssessment,
  otlpPayloads: number,
) {
  return {
    schemaVersion: 1,
    generatedAt: generatedAt.toISOString(),
    model: `openai:${modelId}`,
    configuration: {
      executionSurface: 'packages/cli/src/cli.ts chat --auto --trace --store, followed by trace --json',
      applicationDefaultDriver: '@kuralle-agents/pi-driver / @earendil-works/pi-agent-core',
      aiSdkBaseline: 'Kuralle TextDriver / Vercel AI SDK',
      piTypedFlows: 'pi',
      ttftDefinition: 'milliseconds from trace start to first non-empty client text-delta',
      scenarioCount: new Set(results.map((result) => result.scenario)).size,
    },
    summary: selectedDrivers.map((driver) => summarizeDriver(results.filter((result) => result.driver === driver))),
    otlp: { ...otlp, payloads: otlpPayloads },
    results,
  };
}

function summarizeDriver(results: ScenarioResult[]) {
  const ttft = results.flatMap((result) => result.ttftMs);
  const total = results.flatMap((result) => result.totalMs);
  return {
    driver: results[0]?.driver,
    passedScenarios: results.filter((result) => result.passed).length,
    scenarios: results.length,
    turns: ttft.length,
    medianTtftMs: median(ttft),
    medianTotalMs: median(total),
  };
}

function printResult(result: ScenarioResult): void {
  const ttft = result.ttftMs.length ? `${Math.round(median(result.ttftMs))}ms` : 'none';
  const total = result.totalMs.length ? `${Math.round(median(result.totalMs))}ms` : 'none';
  console.log(
    `${result.passed ? 'PASS' : 'FAIL'} ${result.driver.padEnd(7)} ${result.scenario.padEnd(40)} ` +
    `turns=${result.traceCount} TTFT=${ttft} total=${total}`,
  );
  if (!result.passed) console.log(`     ${result.failures.join(', ')}`);
}

function printSummary(results: ScenarioResult[], otlp: OtlpAssessment, runDir: string): void {
  console.log('\nSummary');
  for (const driver of selectedDrivers) {
    const summary = summarizeDriver(results.filter((result) => result.driver === driver));
    console.log(
      `${driver.padEnd(8)} ${summary.passedScenarios}/${summary.scenarios} scenarios ` +
      `median TTFT=${Math.round(summary.medianTtftMs)}ms median total=${Math.round(summary.medianTotalMs)}ms`,
    );
  }
  console.log(`OTLP     ${otlp.passed ? 'PASS' : `FAIL (${otlp.failures.join(', ')})`} · ${otlp.spanCount} spans · ${otlp.kinds.join(', ')}`);
  console.log(`artifacts: ${runDir}`);
}

async function command(argv: string[], env: Record<string, string | undefined>): Promise<CommandResult> {
  const proc = Bun.spawn(argv, {
    cwd: repoRoot,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 6 * 60_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);
  return { code, stdout, stderr };
}

async function startOtlpCollector(): Promise<{
  endpoint: string;
  payloads: unknown[];
  settle(): Promise<void>;
  close(): Promise<void>;
}> {
  const payloads: unknown[] = [];
  let pending = 0;
  const server = createServer((request, response) => {
    pending += 1;
    readJson(request).then((payload) => {
      if (request.url === '/v1/traces') payloads.push(payload);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    }).catch((error) => {
      response.writeHead(400).end(error instanceof Error ? error.message : String(error));
    }).finally(() => { pending -= 1; });
  });
  await listen(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not resolve OTLP collector address.');
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    payloads,
    async settle() {
      for (let attempt = 0; pending > 0 && attempt < 100; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    close: () => new Promise<void>((resolveClose, reject) =>
      server.close((error) => error ? reject(error) : resolveClose())),
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('error', reject);
    request.on('end', () => {
      try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { reject(error); }
    });
  });
}

function extractOtlpSpans(payload: unknown): Array<Record<string, unknown>> {
  const root = payload as { resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: Array<Record<string, unknown>> }> }> };
  return root.resourceSpans?.flatMap((resource) =>
    resource.scopeSpans?.flatMap((scope) => scope.spans ?? []) ?? []) ?? [];
}

function otlpKind(span: Record<string, unknown>): string {
  const attributes = span.attributes as Array<{ key?: string; value?: { stringValue?: string } }> | undefined;
  return attributes?.find((attribute) => attribute.key === 'kuralle.kind')?.value?.stringValue ?? '';
}

function hasOtlpTtft(span: Record<string, unknown>): boolean {
  const attributes = span.attributes as Array<{ key?: string }> | undefined;
  return attributes?.some((attribute) => attribute.key === 'kuralle.ttftMs') ?? false;
}

function turnTtft(trace: AgentTrace): number | undefined {
  return trace.spans.find((span) => span.kind === 'turn')?.attributes.ttftMs;
}

function traceDuration(trace: AgentTrace): number {
  return Math.max(0, (trace.endedAt ?? trace.startedAt) - trace.startedAt);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function selectRepeated(name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]!);
  }
  return values;
}

function selectDrivers(): DriverName[] {
  const values = selectRepeated('--driver');
  if (values.length === 0) return ['ai-sdk', 'pi'];
  for (const value of values) {
    if (value !== 'ai-sdk' && value !== 'pi') throw new Error(`Unknown driver: ${value}`);
  }
  return [...new Set(values)] as DriverName[];
}

function findScenario(id: string): StressScenario {
  const scenario = ALL_SCENARIOS.find((item) => item.id === id);
  if (!scenario) throw new Error(`Unknown scenario ${id}. Available: ${ALL_SCENARIOS.map((item) => item.id).join(', ')}`);
  return scenario;
}

async function assertScenarioInventory(): Promise<void> {
  const ids = new Set(ALL_SCENARIOS.map((scenario) => scenario.id));
  if (ids.size !== ALL_SCENARIOS.length) throw new Error('Scenario ids must be unique.');
  const flowDir = resolve(repoRoot, 'packages/core/examples/flows');
  const sources = (await readdir(flowDir))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `packages/core/examples/flows/${name}`)
    .sort();
  const covered = CORE_FLOW_SCENARIOS.map((scenario) => scenario.source).sort();
  if (JSON.stringify(sources) !== JSON.stringify(covered)) {
    const missing = sources.filter((source) => !covered.includes(source));
    const stale = covered.filter((source) => !sources.includes(source));
    throw new Error(`Core flow matrix drifted. Missing: ${missing.join(', ') || 'none'}; stale: ${stale.join(', ') || 'none'}.`);
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B(?:[@-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
