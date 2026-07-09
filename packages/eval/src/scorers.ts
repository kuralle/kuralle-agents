import type { TranscriptReplay } from './replay.js';

/**
 * A scoring plugin. Runs after the built-in assertions (tool calls, event
 * order, etc.) and produces a numeric score plus a pass/fail signal.
 *
 * Custom scorers are registered in `registerScorer()`; `GoldenCase.scorers`
 * in the manifest references them by name. The eval loop dispatches to each
 * referenced scorer and aggregates the results alongside the built-in checks.
 */
export interface Scorer {
  /**
   * Run this scorer against a replay. The `expected` value comes from the
   * golden manifest — shape is scorer-specific, so plugins declare their
   * own expected schema.
   */
  score(
    replay: TranscriptReplay,
    expected?: unknown,
  ): Promise<ScorerResult> | ScorerResult;
}

export interface ScorerResult {
  pass: boolean;
  /** Numeric score in [0, 1]. Convention, not enforced. */
  score: number;
  /** Optional human-readable explanation — shown on failure. */
  reason?: string;
}

const registry = new Map<string, Scorer>();

export function registerScorer(name: string, scorer: Scorer): void {
  registry.set(name, scorer);
}

export function getScorer(name: string): Scorer | undefined {
  return registry.get(name);
}

export function listScorers(): string[] {
  return Array.from(registry.keys()).sort();
}

/** Test helper: drop all registered scorers. */
export function clearScorers(): void {
  registry.clear();
}
