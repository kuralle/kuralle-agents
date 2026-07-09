import type { EvalTurn, ScenarioScore, TurnScore } from './types.js';

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/**
 * Score a single turn against expectations.
 * @param extractionSnapshot — flow `context.collectedData` after the turn (optional).
 */
export function scoreTurn(
  expect: EvalTurn['expect'],
  response: string,
  toolsCalled: string[],
  transitions: Array<{ from: string; to: string }>,
  latencyMs: number,
  extractionSnapshot?: Record<string, unknown>,
): Array<{ name: string; passed: boolean; detail: string }> {
  const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
  if (!expect) {
    return checks;
  }

  const toolSet = new Set(toolsCalled);

  if (expect.toolCalls) {
    for (const tool of expect.toolCalls) {
      const passed = toolSet.has(tool);
      checks.push({
        name: `tool:${tool}`,
        passed,
        detail: passed ? `Observed tool call "${tool}"` : `Missing tool call "${tool}"; got: ${[...toolSet].join(', ') || '(none)'}`,
      });
    }
  }

  if (expect.noToolCalls) {
    for (const tool of expect.noToolCalls) {
      const passed = !toolSet.has(tool);
      checks.push({
        name: `no-tool:${tool}`,
        passed,
        detail: passed
          ? `Tool "${tool}" was not called`
          : `Tool "${tool}" was called but should not have been`,
      });
    }
  }

  if (expect.flowTransition) {
    const { from, to } = expect.flowTransition;
    const passed = transitions.some(t => t.from === from && t.to === to);
    checks.push({
      name: 'transition',
      passed,
      detail: passed
        ? `Saw transition ${from} → ${to}`
        : `Expected transition ${from} → ${to}; saw: ${
          transitions.length ? transitions.map(t => `${t.from}→${t.to}`).join('; ') : '(none)'
        }`,
    });
  }

  if (expect.extractionFields && extractionSnapshot) {
    for (const [key, expectedVal] of Object.entries(expect.extractionFields)) {
      const actual = extractionSnapshot[key];
      const passed = valuesEqual(actual, expectedVal);
      checks.push({
        name: `extraction:${key}`,
        passed,
        detail: passed
          ? `Field "${key}" matches expected`
          : `Field "${key}": expected ${JSON.stringify(expectedVal)}, got ${JSON.stringify(actual)}`,
      });
    }
  } else if (expect.extractionFields && !extractionSnapshot) {
    checks.push({
      name: 'extraction',
      passed: false,
      detail: 'Expected extractionFields checks but no flow extraction snapshot was available',
    });
  }

  if (expect.responseContains) {
    for (const phrase of expect.responseContains) {
      const passed = response.includes(phrase);
      checks.push({
        name: `contains:${phrase}`,
        passed,
        detail: passed ? `Response contains "${phrase}"` : `Response missing substring "${phrase}"`,
      });
    }
  }

  if (expect.responseNotContains) {
    for (const phrase of expect.responseNotContains) {
      const passed = !response.includes(phrase);
      checks.push({
        name: `notContains:${phrase}`,
        passed,
        detail: passed ? `Response does not contain "${phrase}"` : `Response should not contain "${phrase}"`,
      });
    }
  }

  if (expect.maxLatencyMs !== undefined) {
    const passed = latencyMs <= expect.maxLatencyMs;
    checks.push({
      name: 'latency',
      passed,
      detail: passed
        ? `Latency ${latencyMs}ms within ${expect.maxLatencyMs}ms`
        : `Latency ${latencyMs}ms exceeds max ${expect.maxLatencyMs}ms`,
    });
  }

  return checks;
}

function accuracyForPrefix(turns: TurnScore[], prefixes: string[]): number {
  let total = 0;
  let passed = 0;
  for (const t of turns) {
    for (const c of t.checks) {
      if (prefixes.some(p => c.name.startsWith(p))) {
        total++;
        if (c.passed) passed++;
      }
    }
  }
  return total === 0 ? 1 : passed / total;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const pos = (p / 100) * (sorted.length - 1);
  return sorted[Math.round(pos)]!;
}

export function aggregateScores(
  scenarioName: string,
  mode: 'text' | 'voice',
  turnScores: TurnScore[],
): ScenarioScore {
  const totalTurns = turnScores.length;
  const passedTurns = turnScores.filter(t => t.passed).length;
  const failedTurns = totalTurns - passedTurns;
  const passRate = totalTurns === 0 ? 1 : passedTurns / totalTurns;

  const latencies = turnScores.map(t => t.latencyMs).sort((a, b) => a - b);
  const sum = latencies.reduce((a, b) => a + b, 0);
  const avgLatencyMs = totalTurns === 0 ? 0 : sum / totalTurns;

  const toolCallAccuracy = accuracyForPrefix(turnScores, ['tool:', 'no-tool:']);
  const extractionAccuracy = accuracyForPrefix(turnScores, ['extraction:']);

  return {
    scenario: scenarioName,
    mode,
    passed: failedTurns === 0,
    turnScores,
    aggregate: {
      passRate,
      totalTurns,
      passedTurns,
      failedTurns,
      avgLatencyMs,
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
      toolCallAccuracy,
      extractionAccuracy,
    },
  };
}
