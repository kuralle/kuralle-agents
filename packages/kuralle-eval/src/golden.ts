import { readFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { ReplayAssertionError, TranscriptReplay } from './replay.js';
import { getScorer } from './scorers.js';

export interface GoldenToolExpectation {
  name: string;
  minCount?: number;
}

/**
 * Reference to a custom scorer. Resolved at run time against the scorer
 * registry; unknown names cause the case to fail.
 */
export interface GoldenScorerReference {
  name: string;
  expected?: unknown;
  minScore?: number;
}

export interface GoldenCase {
  name: string;
  file: string;
  expectEventOrder?: string[];
  expectNoErrors?: boolean;
  expectDone?: boolean;
  expectNoToolMismatches?: boolean;
  requireTools?: GoldenToolExpectation[];
  scorers?: GoldenScorerReference[];
}

export interface GoldenSuiteResult {
  total: number;
  passed: number;
  failed: number;
  failures: Array<{ name: string; error: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function toGoldenCase(value: unknown, index: number): GoldenCase {
  if (!isRecord(value)) {
    throw new Error(`Invalid manifest item at index ${index}: expected object`);
  }
  if (typeof value.name !== 'string' || value.name.length === 0) {
    throw new Error(`Invalid manifest item at index ${index}: missing name`);
  }
  if (typeof value.file !== 'string' || value.file.length === 0) {
    throw new Error(`Invalid manifest item at index ${index}: missing file`);
  }

  const tools: GoldenToolExpectation[] = [];
  if (Array.isArray(value.requireTools)) {
    for (const tool of value.requireTools) {
      if (!isRecord(tool) || typeof tool.name !== 'string' || tool.name.length === 0) {
        throw new Error(`Invalid requireTools entry for case "${value.name}"`);
      }
      tools.push({
        name: tool.name,
        minCount: typeof tool.minCount === 'number' ? tool.minCount : 1,
      });
    }
  }

  const scorers: GoldenScorerReference[] = [];
  if (Array.isArray(value.scorers)) {
    for (const scorer of value.scorers) {
      if (!isRecord(scorer) || typeof scorer.name !== 'string' || scorer.name.length === 0) {
        throw new Error(`Invalid scorers entry for case "${value.name}"`);
      }
      scorers.push({
        name: scorer.name,
        expected: scorer.expected,
        minScore: typeof scorer.minScore === 'number' ? scorer.minScore : undefined,
      });
    }
  }

  return {
    name: value.name,
    file: value.file,
    expectEventOrder: Array.isArray(value.expectEventOrder)
      ? value.expectEventOrder.filter((v): v is string => typeof v === 'string')
      : undefined,
    expectNoErrors: value.expectNoErrors !== false,
    expectDone: value.expectDone !== false,
    expectNoToolMismatches: value.expectNoToolMismatches !== false,
    requireTools: tools,
    scorers,
  };
}

export async function loadGoldenManifest(manifestPath: string): Promise<GoldenCase[]> {
  const absolutePath = resolve(manifestPath);
  const text = await readFile(absolutePath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid manifest JSON at ${absolutePath}: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid manifest format at ${absolutePath}: expected array`);
  }
  return parsed.map((item, index) => toGoldenCase(item, index));
}

async function runGoldenCase(baseDir: string, goldenCase: GoldenCase): Promise<void> {
  const path = resolve(baseDir, goldenCase.file);
  const replay = await TranscriptReplay.fromFile(path);

  if (goldenCase.expectEventOrder && goldenCase.expectEventOrder.length > 0) {
    replay.expectEventOrder(goldenCase.expectEventOrder);
  }
  if (goldenCase.expectNoErrors !== false) {
    replay.expectNoErrors();
  }
  if (goldenCase.expectDone !== false) {
    replay.expectDone();
  }
  if (goldenCase.expectNoToolMismatches !== false) {
    replay.expectNoToolMismatches();
  }
  for (const tool of goldenCase.requireTools ?? []) {
    replay.expectToolCalled(tool.name, tool.minCount ?? 1);
  }

  for (const ref of goldenCase.scorers ?? []) {
    const scorer = getScorer(ref.name);
    if (!scorer) {
      throw new ReplayAssertionError(
        `Scorer "${ref.name}" is not registered. Call registerScorer() before running the suite.`,
      );
    }
    const result = await scorer.score(replay, ref.expected);
    const minScore = ref.minScore ?? (result.pass ? 0 : 1);
    if (!result.pass || result.score < minScore) {
      throw new ReplayAssertionError(
        `Scorer "${ref.name}" failed: score=${result.score}${ref.minScore !== undefined ? ` (min=${ref.minScore})` : ''}` +
        (result.reason ? ` — ${result.reason}` : ''),
      );
    }
  }
}

export async function runGoldenSuite(manifestPath?: string): Promise<GoldenSuiteResult> {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const effectiveManifestPath = manifestPath
    ? resolve(manifestPath)
    : resolve(currentDir, '../fixtures/golden.manifest.json');
  const manifestDir = dirname(effectiveManifestPath);
  const goldenCases = await loadGoldenManifest(effectiveManifestPath);

  const failures: Array<{ name: string; error: string }> = [];
  let passed = 0;

  for (const goldenCase of goldenCases) {
    try {
      await runGoldenCase(manifestDir, goldenCase);
      passed += 1;
    } catch (error) {
      const message = error instanceof ReplayAssertionError || error instanceof Error
        ? error.message
        : String(error);
      failures.push({ name: goldenCase.name, error: message });
    }
  }

  return {
    total: goldenCases.length,
    passed,
    failed: failures.length,
    failures,
  };
}

async function main(): Promise<void> {
  const manifestArg = process.argv[2];
  const result = await runGoldenSuite(manifestArg);

  if (result.failed === 0) {
    console.log(`[kuralle-eval] Golden suite passed (${result.passed}/${result.total}).`);
    return;
  }

  console.error(`[kuralle-eval] Golden suite failed (${result.failed}/${result.total}).`);
  for (const failure of result.failures) {
    console.error(`- ${failure.name}: ${failure.error}`);
  }
  process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  void main();
}
