/**
 * @module retry
 *
 * Generic exponential-backoff retry queue.
 *
 * Retry decisions are delegated to the thrown error's `retryable` flag. An
 * {@link ErrorClassifier} (or the caller) is expected to attach that flag
 * before the retry queue inspects the error. Network-level failures thrown
 * by `fetch` (TypeError) are always treated as retryable. All other errors
 * default to non-retryable.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Retry behaviour configuration. */
export interface RetryConfig {
  /** Maximum number of retry attempts (does not count the initial attempt). Default `3`. */
  maxRetries: number;
  /** Base delay in milliseconds before the first retry. Default `1000`. */
  baseDelayMs: number;
  /** Upper bound on computed delay in milliseconds. Default `30000`. */
  maxDelayMs: number;
}

/** Sensible defaults matching common REST-API retry guidance. */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
};

// ---------------------------------------------------------------------------
// RetryableError marker
// ---------------------------------------------------------------------------

/**
 * A thrown value that carries explicit retry semantics.
 *
 * Errors produced by an {@link ErrorClassifier} implement this shape so the
 * {@link RetryQueue} can make a decision without platform-specific knowledge.
 */
export interface RetryableError {
  retryable: boolean;
  retryAfterMs?: number;
}

export function isRetryableError(value: unknown): value is Error & RetryableError {
  return (
    value instanceof Error &&
    typeof (value as { retryable?: unknown }).retryable === 'boolean'
  );
}

// ---------------------------------------------------------------------------
// RetryQueue
// ---------------------------------------------------------------------------

/**
 * Retry queue that wraps an async function with exponential backoff + jitter.
 *
 * @example
 * ```ts
 * const queue = new RetryQueue({ maxRetries: 2 });
 * const data = await queue.execute(() => fetch(url).then(r => r.json()));
 * ```
 */
export class RetryQueue {
  private readonly config: RetryConfig;

  constructor(config: Partial<RetryConfig> = {}) {
    this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
  }

  /**
   * Execute `fn` with automatic retries on transient failures.
   *
   * @param fn - The async operation to execute.
   * @returns The resolved value of `fn`.
   * @throws The last error if all retries are exhausted or the error is non-retryable.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;

        if (!this.isRetryable(error) || attempt === this.config.maxRetries) {
          throw lastError;
        }

        const exponentialDelay = this.config.baseDelayMs * Math.pow(2, attempt);
        const jitter = Math.random() * 1_000;
        let delay = Math.min(exponentialDelay + jitter, this.config.maxDelayMs);

        if (isRetryableError(error) && typeof error.retryAfterMs === 'number' && error.retryAfterMs > delay) {
          delay = Math.min(error.retryAfterMs, this.config.maxDelayMs);
        }

        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError!;
  }

  /**
   * Retry policy:
   *
   * - If the error implements {@link RetryableError}, its `retryable` flag wins.
   * - Plain `TypeError`s thrown by `fetch` (DNS failure, TCP reset) are
   *   treated as transient and retryable.
   * - Everything else is permanent.
   */
  private isRetryable(error: unknown): boolean {
    if (isRetryableError(error)) {
      return error.retryable;
    }
    if (error instanceof TypeError) {
      return true;
    }
    return false;
  }
}
