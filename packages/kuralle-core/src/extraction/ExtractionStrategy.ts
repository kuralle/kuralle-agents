import type { LanguageModel, TelemetrySettings } from 'ai';
import type { ZodTypeAny } from 'zod';

/**
 * Input to a single extraction pass.
 *
 * All implementations read these fields; individual strategies may ignore
 * those they do not need (e.g. a stateful capability ignores `model` and
 * `userInput` when it processes tool results instead of running a fresh
 * LLM call).
 */
export interface ExtractionPassParams {
  schema: ZodTypeAny;
  requiredFields: string[];
  userInput: string;
  currentData: Record<string, unknown>;
  systemPrompt?: string;
  model?: LanguageModel;
  telemetry?: TelemetrySettings;
}

export interface ExtractionPassResult {
  extractedFields: Record<string, unknown>;
  mergedData: Record<string, unknown>;
  missingFields: string[];
  complete: boolean;
}

/**
 * Uniform extraction strategy interface implemented by the three
 * orchestrators that consume `flows/extraction.ts` primitives:
 *   - RealtimeExtractionRunner  (post-turn LLM extraction, voice path)
 *   - ExtractionEngine          (turn-wrapped LLM extraction, text path)
 *   - ExtractionCapability      (stateful tool-driven capability)
 *
 * Each implementation has a distinct pipeline (fresh LLM call vs. tool
 * result processing vs. capability-managed state). The interface lets
 * callers inject any strategy for swap-in testability without changing
 * the shared extraction primitives in flows/extraction.ts.
 */
export interface ExtractionStrategy {
  /** Human-readable name used in telemetry and diagnostics. */
  readonly name: string;

  /**
   * Execute one extraction pass and return merged + completion state.
   * Stateful strategies may also update their internal state.
   */
  runExtractionPass(params: ExtractionPassParams): Promise<ExtractionPassResult>;
}
