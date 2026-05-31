/**
 * Context Budget System for Kuralle.
 *
 * Manages token allocation across the multiple content sources that compose
 * each LLM request. Ensures no single section can monopolize the context window.
 */

/**
 * ContextBudgetConfig defines the token allocation strategy for the LLM
 * context window. It governs how the finite context window is partitioned
 * across the multiple content sources that compose each LLM request.
 */
export interface ContextBudgetConfig {
  /** Total context window size of the target model, in tokens. Default: 128,000. */
  modelContextWindow: number;

  /** Tokens reserved for the LLM's response generation. Default: 4,096. */
  responseReserve: number;

  /** Maximum tokens allocated to auto-retrieve (RAG) context injection. Default: 4,000. */
  maxAutoRetrieveTokens: number;

  /** Maximum tokens allocated to the working memory section. Default: 2,000. */
  maxWorkingMemoryTokens: number;

  /** Maximum tokens allocated to the extraction snapshot section. Default: 2,000. */
  maxExtractionTokens: number;

  /** Maximum tokens allocated to cross-session long-term memory. Default: 2,000. */
  maxLongTermMemoryTokens: number;

  /**
   * Maximum tokens allocated to the base system prompt.
   * 0 means no limit — the base prompt is measured, not capped.
   * Default: 0.
   */
  maxBasePromptTokens: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudgetConfig = {
  modelContextWindow: 128_000,
  responseReserve: 4_096,
  maxAutoRetrieveTokens: 4_000,
  maxWorkingMemoryTokens: 2_000,
  maxExtractionTokens: 2_000,
  maxLongTermMemoryTokens: 2_000,
  maxBasePromptTokens: 0,
};

/** Preset for realtime / voice agents — smaller window and allocations for low-latency turns. */
export const VOICE_CONTEXT_BUDGET: ContextBudgetConfig = {
  modelContextWindow: 16_000,
  responseReserve: 1_024,
  maxAutoRetrieveTokens: 1_000,
  maxWorkingMemoryTokens: 500,
  maxExtractionTokens: 500,
  maxLongTermMemoryTokens: 500,
  maxBasePromptTokens: 0,
};

/**
 * Token estimation function. Uses a rough 4:1 character-to-token ratio.
 * Consistent with ContextManager.ts.
 */
export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Computes the remaining token budget available for message history after
 * all system prompt sections have been allocated.
 *
 * Floors at 1000 tokens to ensure the LLM always sees at least minimal
 * conversation history.
 */
export function computeMessageHistoryBudget(
  config: ContextBudgetConfig,
  measuredBasePromptTokens: number,
  measuredPolicyInjectionTokens: number,
): number {
  const systemBudget =
    measuredBasePromptTokens +
    config.maxAutoRetrieveTokens +
    config.maxWorkingMemoryTokens +
    config.maxExtractionTokens +
    config.maxLongTermMemoryTokens +
    measuredPolicyInjectionTokens;

  const available =
    config.modelContextWindow - config.responseReserve - systemBudget;

  if (available < 1000) {
    console.warn(
      '[Kuralle] Context budget exhausted: system prompt sections consume ' +
        `${systemBudget} tokens, leaving only ${available} tokens for message ` +
        'history. Consider reducing maxAutoRetrieveTokens, maxWorkingMemoryTokens, ' +
        'or the base system prompt size.',
    );
    return Math.max(available, 1000);
  }

  return available;
}

/**
 * Truncates a text string to fit within a token budget.
 * Truncation is at the nearest sentence boundary when possible.
 */
export function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  const estimated = estimateTokenCount(text);
  if (estimated <= maxTokens) return text;

  // Convert token budget to approximate character count
  const maxChars = maxTokens * 4;
  const truncatedRegion = text.slice(0, maxChars);

  // Find the last sentence boundary within the character budget
  const lastSentenceEnd = Math.max(
    truncatedRegion.lastIndexOf('. '),
    truncatedRegion.lastIndexOf('.\n'),
  );

  if (lastSentenceEnd > maxChars * 0.5) {
    return truncatedRegion.slice(0, lastSentenceEnd + 1) + '\n[truncated]';
  }

  // No good sentence boundary — hard truncate
  return truncatedRegion + '\n[truncated]';
}

/**
 * Budget-aware working memory formatter.
 * Iterates entries in insertion order, dropping entries that exceed the budget.
 * Entries are atomic — they are either fully included or fully dropped.
 */
export function formatMemoryWithBudget(
  memory: Record<string, unknown>,
  maxTokens: number,
  allowlist?: string[],
): string {
  if (maxTokens <= 0) return '';

  const entries = Object.entries(memory);
  const filteredEntries = allowlist
    ? entries.filter(([key]) => allowlist.includes(key))
    : entries;

  if (filteredEntries.length === 0) return '';

  const headerLine = '\n\n## Known Information';
  let tokenCount = estimateTokenCount(headerLine);
  const lines: string[] = [headerLine];
  let omitted = 0;

  for (const [key, value] of filteredEntries) {
    const line = `\n- **${key}**: ${typeof value === 'object' ? JSON.stringify(value) : value}`;
    const lineTokens = estimateTokenCount(line);

    if (tokenCount + lineTokens > maxTokens) {
      omitted++;
      continue;
    }

    lines.push(line);
    tokenCount += lineTokens;
  }

  if (omitted > 0) {
    lines.push(`\n[${omitted} entries omitted due to context budget]`);
  }

  return lines.join('');
}

/**
 * Tracks the last pre-flight input token estimate and compares it to provider-reported actuals.
 */
export class ContextBudget {
  private lastEstimate = 0;

  constructor(private readonly config: ContextBudgetConfig) {}

  /** Call after assembling the request (e.g. from `onBeforeModelCall` estimated tokens). */
  recordPreFlightEstimate(estimatedInputTokens: number): void {
    this.lastEstimate = estimatedInputTokens;
  }

  /**
   * Compares the last pre-flight estimate to actual input tokens from the provider.
   * Logs a warning when absolute drift percentage exceeds 20%.
   */
  validateActual(actualInputTokens: number): {
    estimated: number;
    actual: number;
    drift: number;
    driftPct: number;
  } {
    const estimated = this.lastEstimate;
    const actual = actualInputTokens;
    const drift = actual - estimated;
    const driftPct = actual !== 0 ? (drift / actual) * 100 : estimated !== 0 ? 100 : 0;

    if (estimated > 0 && Math.abs(driftPct) > 20) {
      console.warn(
        `[Kuralle] Context budget drift: estimated ${estimated}, actual ${actualInputTokens}, drift ${driftPct.toFixed(1)}%`,
      );
    }

    return { estimated, actual, drift, driftPct };
  }

  get modelContextWindow(): number {
    return this.config.modelContextWindow;
  }
}
